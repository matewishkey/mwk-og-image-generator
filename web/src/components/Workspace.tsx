/**
 * The project workspace island: shots, styles, references and takes on ONE live
 * page. This is the app's single interactive island (everything else stays
 * server-rendered Astro) — it exists because form-POST-reload kept eating
 * mate's edits and hiding save state.
 *
 * Ground rules carried over from the server pages:
 * - Nothing is ever lost: every edit autosaves (debounced), every action
 *   flushes pending saves first, and the poll never clobbers a draft.
 * - Save state is VISIBLE: every shot carries a saved/saving/unsaved badge.
 * - No popups: destructive buttons arm on click and fire on a 1s hold.
 * - Nothing that ran disappears: superseded and hidden takes stay reachable.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { TakesPayload, WsShot, WsTake } from '../lib/workspace';
import type { RefState } from '../lib/media';
import { ICON_PATHS, type IconName } from './icons';

/** Same icon set as Icon.astro — one source, two renderers. */
const I = ({ name }: { name: IconName }) => (
  <svg
    class="i"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden
    dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
  />
);

export interface WsStyle {
  id: string;
  name: string;
  house: boolean;
  thumb: string | null;
}

export interface WsInitial {
  slug: string;
  projectName: string;
  models: string[];
  iterations: number;
  refRole: string | null;
  styles: WsStyle[];
  projectStyleIds: string[];
  primaryStyleId: string;
  /** Sum over the project's models of one cell's price, in micros. */
  perCellMicros: number;
  /** Slowest model's typical seconds; 0 = unknown. */
  maxSeconds: number;
  takes: TakesPayload;
  refs: RefState;
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'empty';

interface EditShot extends WsShot {
  draftLabel: string;
  draftPrompt: string;
  draftRole: string;
  saveState: SaveState;
}

const LIVE = ['queued', 'running', 'rendering'];
const usd = (m: number) => `$${(m / 1_000_000).toFixed(m >= 100_000 ? 2 : 4)}`;
const CHAIN = /\{\s*shot\s+(\d+)\s*\}/gi;

const asEdit = (s: WsShot): EditShot => ({
  ...s,
  draftLabel: s.label ?? '',
  draftPrompt: s.prompt,
  draftRole: s.ref_role ?? '',
  saveState: 'saved',
});

/** Client-side JPEG conversion, same recipe as the global data-jpeg handler. */
async function toJpeg(file: File): Promise<File> {
  if (file.type === 'image/jpeg') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file; // undecodable files pass through; the server still sniffs them
  }
}

/** No-popup destructive button: click arms it, a 1-second hold fires. */
function HoldButton(props: { label: ComponentChildren; confirm: string; onFire: () => void; cls?: string }) {
  const [state, setState] = useState<'idle' | 'armed' | 'holding'>('idle');
  const disarm = useRef<number>();
  const hold = useRef<number>();
  const reset = () => {
    clearTimeout(disarm.current);
    clearTimeout(hold.current);
    setState('idle');
  };
  const start = () => {
    setState('holding');
    hold.current = window.setTimeout(() => {
      reset();
      props.onFire();
    }, 1000);
  };
  const cancel = () => {
    if (state !== 'holding') return;
    clearTimeout(hold.current);
    setState('armed');
  };
  return (
    <button
      type="button"
      class={`btn small ghost ${props.cls ?? ''} ${state !== 'idle' ? 'arming' : ''} ${state === 'holding' ? 'holding' : ''}`}
      onClick={(e) => {
        e.preventDefault();
        if (state === 'idle') {
          setState('armed');
          disarm.current = window.setTimeout(reset, 10_000);
        }
      }}
      onPointerDown={() => state === 'armed' && start()}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && state === 'armed' && !e.repeat) start();
      }}
      onKeyUp={cancel}
    >
      {state === 'idle' ? props.label : props.confirm}
    </button>
  );
}

export default function Workspace({ initial }: { initial: WsInitial }) {
  const { slug, iterations, projectStyleIds, primaryStyleId } = initial;
  const [shots, setShots] = useState<EditShot[]>(initial.takes.shots.map(asEdit));
  const [takes, setTakes] = useState<WsTake[]>(initial.takes.takes);
  const [spent, setSpent] = useState(initial.takes.spentMicros);
  const [live, setLive] = useState(initial.takes.live);
  const [refs, setRefs] = useState<RefState>(initial.refs);
  const [projRole, setProjRole] = useState(initial.refRole ?? '');
  const [roleState, setRoleState] = useState<SaveState>('saved');
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [addLabel, setAddLabel] = useState('');
  const [addPrompt, setAddPrompt] = useState('');

  const shotsRef = useRef(shots);
  shotsRef.current = shots;
  const timers = useRef(new Map<string, number>());
  const styleById = new Map(initial.styles.map((s) => [s.id, s]));

  // ---------- API ----------
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(`/api/projects/${slug}${path}`, init);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(data.error ?? `HTTP ${res.status}`));
    return data;
  };
  const post = (path: string, body: unknown) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusy((b) => ({ ...b, [key]: true }));
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  };

  // ---------- save-state (the headline) ----------
  const patchShot = (id: string, patch: Partial<EditShot>) =>
    setShots((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const saveShot = async (id: string) => {
    const s = shotsRef.current.find((x) => x.id === id);
    if (!s || (s.saveState !== 'dirty' && s.saveState !== 'error')) return;
    if (!s.draftPrompt.trim()) {
      patchShot(id, { saveState: 'empty' });
      return;
    }
    const sent = { prompt: s.draftPrompt, label: s.draftLabel, refRole: s.draftRole };
    patchShot(id, { saveState: 'saving' });
    try {
      await post('/shots', { action: 'edit', shot: id, ...sent });
      const cur = shotsRef.current.find((x) => x.id === id);
      const clean =
        cur &&
        cur.draftPrompt === sent.prompt &&
        cur.draftLabel === sent.label &&
        cur.draftRole === sent.refRole;
      patchShot(id, {
        saveState: clean ? 'saved' : 'dirty',
        prompt: sent.prompt,
        label: sent.label || null,
        ref_role: sent.refRole || null,
      });
      if (!clean) scheduleSave(id);
    } catch {
      patchShot(id, { saveState: 'error' });
      window.setTimeout(() => {
        const cur = shotsRef.current.find((x) => x.id === id);
        if (cur?.saveState === 'error') {
          patchShot(id, { saveState: 'dirty' });
          void saveShot(id);
        }
      }, 3000);
    }
  };

  const scheduleSave = (id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(id, window.setTimeout(() => void saveShot(id), 800));
  };

  const editShot = (id: string, patch: Partial<Pick<EditShot, 'draftLabel' | 'draftPrompt' | 'draftRole'>>) => {
    patchShot(id, { ...patch, saveState: 'dirty' });
    scheduleSave(id);
  };

  /** Every action goes through this: pending edits land first, always. */
  const flushSaves = async () => {
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
    await Promise.all(
      shotsRef.current
        .filter((s) => s.saveState === 'dirty' || s.saveState === 'error')
        .map((s) => saveShot(s.id)),
    );
  };

  const anyDirty = shots.some((s) => s.saveState !== 'saved') || roleState !== 'saved';
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (anyDirty) e.preventDefault();
    };
    addEventListener('beforeunload', h);
    return () => removeEventListener('beforeunload', h);
  }, [anyDirty]);

  // ---------- polling (never clobbers a draft) ----------
  const refresh = async () => {
    const p = (await call('/takes')) as unknown as TakesPayload;
    setTakes(p.takes);
    setSpent(p.spentMicros);
    setLive(p.live);
    setShots((prev) => {
      const byId = new Map(prev.map((s) => [s.id, s]));
      return p.shots.map((srv) => {
        const cur = byId.get(srv.id);
        if (!cur) return asEdit(srv);
        // Server truth for run-derived fields; local drafts stay untouched.
        return {
          ...cur,
          position: srv.position,
          picked_take_id: srv.picked_take_id,
          style_override_id: srv.style_override_id,
        };
      });
    });
  };

  useEffect(() => {
    if (!live) return;
    const poll = window.setInterval(() => void refresh().catch(() => {}), 3000);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [live]);

  // ---------- estimates ----------
  const stylesFor = (s: WsShot) => (s.style_override_id ? 1 : Math.max(projectStyleIds.length, 1));
  const cellsAll = shots.reduce((n, s) => n + stylesFor(s) * iterations, 0);
  const estAll = cellsAll * initial.perCellMicros;
  const estTime = (cells: number) => {
    if (!initial.maxSeconds) return '';
    const secs = initial.maxSeconds * Math.ceil(cells / 4);
    return secs < 90 ? ` · ~${secs}s` : ` · ~${Math.round(secs / 60)} min`;
  };

  // ---------- actions ----------
  const runAll = () =>
    withBusy('run-all', async () => {
      await flushSaves();
      await post('/run', {});
      await refresh();
    });

  const reshoot = (id: string) =>
    withBusy(`reshoot:${id}`, async () => {
      await flushSaves();
      await post('/shots', { action: 'reshoot', shot: id });
      await refresh();
    });

  const suggest = (id: string) =>
    withBusy(`suggest:${id}`, async () => {
      await flushSaves();
      const r = (await post('/shots', { action: 'suggest', shot: id })) as { variants: string[] };
      setSuggestions((s) => ({ ...s, [id]: r.variants }));
      setTimeout(() => document.getElementById(`sugg-${id}`)?.scrollIntoView({ block: 'center' }), 50);
    });

  const useVariant = (id: string, text: string, mode: 'replace' | 'append') => {
    const s = shotsRef.current.find((x) => x.id === id);
    if (!s) return;
    editShot(id, {
      draftPrompt: mode === 'replace' ? text : `${s.draftPrompt.trimEnd()}\n${text}`,
    });
    setSuggestions((sg) => {
      const { [id]: _, ...rest } = sg;
      return rest;
    });
  };

  const setStyle = (id: string, styleId: string) =>
    withBusy(`style:${id}`, async () => {
      await flushSaves();
      await post('/shots', { action: 'set-style', shot: id, style: styleId });
      patchShot(id, { style_override_id: styleId || null });
    });

  const takeAction = (takeId: string, action: 'pick' | 'hide' | 'unhide' | 'reroll') =>
    withBusy(`${action}:${takeId}`, async () => {
      await post('/takes', { action, take: takeId });
      await refresh();
    });

  const deleteShot = (id: string) =>
    withBusy(`delete:${id}`, async () => {
      await post('/shots', { action: 'delete', shot: id });
      setShots((prev) => prev.filter((s) => s.id !== id));
    });

  const addShot = () =>
    withBusy('add-shot', async () => {
      if (!addPrompt.trim()) throw new Error('The new shot needs a prompt.');
      await post('/shots', { action: 'add', prompt: addPrompt, label: addLabel });
      setAddLabel('');
      setAddPrompt('');
      await refresh();
    });

  const refAction = (body: Record<string, unknown>, key: string) =>
    withBusy(key, async () => {
      const r = (await post('/refs', body)) as unknown as RefState;
      setRefs(r);
    });

  const saveRole = () =>
    withBusy('role', async () => {
      setRoleState('saving');
      await post('/refs', { action: 'role', refRole: projRole });
      setRoleState('saved');
    });

  const upload = (files: FileList | null, shot?: string) =>
    withBusy(shot ? `upload:${shot}` : 'upload', async () => {
      if (!files?.length) return;
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append('photos', await toJpeg(f), f.name);
      if (shot) fd.append('shot', shot);
      const res = await fetch(`/api/projects/${slug}/refs`, { method: 'POST', body: fd });
      const data = (await res.json()) as RefState & { errors?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (data.errors?.length) setError(data.errors.join(' '));
      setRefs(data);
    });

  // ---------- derived ----------
  const takesFor = (shotId: string) =>
    takes
      .filter((t) => t.shot_id === shotId)
      .sort(
        (a, b) =>
          a.model_alias.localeCompare(b.model_alias) ||
          a.iteration - b.iteration ||
          Number(a.superseded) - Number(b.superseded) ||
          b.created_at.localeCompare(a.created_at),
      );
  const pickedCount = shots.filter((s) => s.picked_take_id).length;
  const throttled = takes.some((t) => t.error_kind === 'throttled');
  const styleName = (id: string) => styleById.get(id)?.name ?? 'style';
  const multiStyle = projectStyleIds.length > 1;

  const badge = (state: SaveState) =>
    ({
      saved: ['ws-badge saved', 'Saved ✓'],
      dirty: ['ws-badge dirty', 'Unsaved…'],
      saving: ['ws-badge saving', 'Saving…'],
      error: ['ws-badge err', 'Save failed — retrying'],
      empty: ['ws-badge err', 'Empty prompt — not saved'],
    })[state];

  const chainNote = (prompt: string) => {
    const targets = [...prompt.matchAll(CHAIN)].map((m) => Number(m[1]));
    if (!targets.length) return null;
    const missing = targets.filter(
      (n) => !shots.find((s) => s.position === n)?.picked_take_id,
    );
    return missing.length
      ? `⚠ chains shot ${missing.join(', ')} — it needs a picked take before this can run`
      : `⛓ carries the picked character from shot ${[...new Set(targets)].join(', ')}`;
  };

  // ---------- render ----------
  return (
    <div class="ws">
      {error && <p class="flash">{error}</p>}
      {throttled && (
        <p class="flash">Replicate is throttling — this usually means the account balance is under $5, not a bug.</p>
      )}

      <div class="ws-top">
        <p class="sub">
          Spent so far: <span class="money">{usd(spent)}</span> · {pickedCount}/{shots.length} picked
          {multiStyle && <> · {projectStyleIds.length} styles per shot</>}
          {' '}· a re-roll is a new take — the old one is never overwritten
        </p>
        <button class={`btn ${busy['run-all'] ? 'running' : ''}`} disabled={!shots.length || busy['run-all']} onClick={runAll}>
          {busy['run-all']
            ? 'Starting the run…'
            : `Run all ${shots.length} shot${shots.length === 1 ? '' : 's'} · ${usd(estAll)}${estTime(cellsAll)}`}
        </button>
      </div>

      {shots.map((shot) => {
        const visible = takesFor(shot.id).filter((t) => !t.hidden);
        const hidden = takesFor(shot.id).filter((t) => t.hidden);
        const shotRefs = refs.shots[shot.id] ?? [];
        const attachable = refs.library.filter(
          (r) => !shotRefs.some((x) => x.id === r.id) && !refs.project.some((x) => x.id === r.id),
        );
        const [badgeCls, badgeText] = badge(shot.saveState);
        const note = chainNote(shot.draftPrompt);
        const perShot = stylesFor(shot) * iterations * initial.perCellMicros;
        return (
          <section class="card ws-shot" key={shot.id}>
            <header class="ws-shot-head">
              <span class="mono ws-pos">{shot.position}</span>
              <b>{shot.draftLabel || `Shot ${shot.position}`}</b>
              {shot.style_override_id && (
                <em class="chip ws-style-chip">{styleName(shot.style_override_id)}</em>
              )}
              <span class={badgeCls}>{badgeText}</span>
              <button
                class={`btn small ghost ws-right ${busy[`reshoot:${shot.id}`] ? 'running' : ''}`}
                disabled={busy[`reshoot:${shot.id}`]}
                title="New takes of just this shot with today's prompt and style — the old ones stay"
                onClick={() => reshoot(shot.id)}
              >
                {busy[`reshoot:${shot.id}`] ? 'Starting…' : <><I name="reshoot" />Re-shoot · {usd(perShot)}</>}
              </button>
            </header>

            <div class="ws-fields">
              <label class="field"><span>Label</span>
                <input type="text" value={shot.draftLabel}
                  onInput={(e) => editShot(shot.id, { draftLabel: (e.target as HTMLInputElement).value })} />
              </label>
              <label class="field"><span>What is happening — never a medium, never a palette. Write {'{shot 1}'} to carry shot 1's picked character into this shot.</span>
                <textarea value={shot.draftPrompt} rows={Math.max(3, Math.ceil(shot.draftPrompt.length / 90))}
                  onInput={(e) => editShot(shot.id, { draftPrompt: (e.target as HTMLTextAreaElement).value })} />
              </label>
              {note && <p class={`ws-chain ${note.startsWith('⚠') ? 'warn' : ''}`}>{note}</p>}
              <label class="field"><span>Who is the reference person in THIS shot (blank = the project's answer)</span>
                <input type="text" value={shot.draftRole} placeholder='e.g. "the interviewer"'
                  onInput={(e) => editShot(shot.id, { draftRole: (e.target as HTMLInputElement).value })} />
              </label>
            </div>

            <div class="ws-row">
              <button class="btn small" onClick={() => { clearTimeout(timers.current.get(shot.id)); void saveShot(shot.id); }}><I name="save" />Save now</button>
              <button class={`btn small ghost ${busy[`suggest:${shot.id}`] ? 'running' : ''}`}
                disabled={busy[`suggest:${shot.id}`]} onClick={() => suggest(shot.id)}>
                {busy[`suggest:${shot.id}`] ? 'Writing…' : <><I name="cowrite" />Co-write — expand this idea</>}
              </button>
              <HoldButton label={<><I name="delete" />Delete shot</>} confirm="sure? hold to delete" onFire={() => deleteShot(shot.id)} />
            </div>

            {suggestions[shot.id] && (
              <div class="ws-suggestions" id={`sugg-${shot.id}`}>
                <p class="kicker"><span class="g">/</span>Co-writer — your idea written out long; nothing changes until you approve one</p>
                {suggestions[shot.id]!.map((v) => (
                  <div class="ws-suggestion">
                    <p>{v}</p>
                    <div class="ws-sugg-actions">
                      <button class="btn small" onClick={() => useVariant(shot.id, v, 'replace')} title="Replace the prompt with this">Use this</button>
                      <button class="btn small ghost" onClick={() => useVariant(shot.id, v, 'append')} title="Keep the prompt, add this under it">Append</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div class="ws-styles">
              <span class="ws-mini">Style — this shot only</span>
              <div class="ws-style-strip">
                <button type="button"
                  class={`ws-style-opt ${!shot.style_override_id ? 'on' : ''}`}
                  onClick={() => setStyle(shot.id, '')}
                  title={multiStyle ? `the project's ${projectStyleIds.length} styles` : 'the project style'}>
                  {styleById.get(primaryStyleId)?.thumb
                    ? <img src={`/img/${styleById.get(primaryStyleId)!.thumb}`} alt="" loading="lazy" />
                    : <span class="ws-style-ph">project</span>}
                  <span>project{multiStyle ? ` (${projectStyleIds.length})` : ''}</span>
                </button>
                {initial.styles.map((st) => (
                  <button type="button"
                    class={`ws-style-opt ${st.id === shot.style_override_id ? 'on' : ''}`}
                    onClick={() => setStyle(shot.id, st.id)} title={st.name}>
                    {st.thumb ? <img src={`/img/${st.thumb}`} alt="" loading="lazy" /> : <span class="ws-style-ph">{st.name}</span>}
                    <span>{st.name}</span>
                  </button>
                ))}
              </div>
            </div>

            <div class="ws-refs">
              <span class="ws-mini">Reference photos on this shot</span>
              <div class="ws-ref-strip">
                {refs.project.map((r) => (
                  <figure class="ws-ref every" title={`${r.name ?? r.filename} — attached to every shot`}>
                    <img src={`/img/${r.r2_key}`} alt="" loading="lazy" />
                    <figcaption>every shot</figcaption>
                  </figure>
                ))}
                {shotRefs.map((r) => (
                  <figure class="ws-ref" title={r.name ?? r.filename}>
                    <img src={`/img/${r.r2_key}`} alt="" loading="lazy" />
                    <figcaption>
                      <button class="linkish" title="Detach from this shot"
                        onClick={() => refAction({ action: 'remove', ref: r.id, shot: shot.id }, `ref:${shot.id}`)}>✕ remove</button>
                    </figcaption>
                  </figure>
                ))}
                {attachable.length > 0 && (
                  <select class="ws-attach" value=""
                    onChange={(e) => {
                      const v = (e.target as HTMLSelectElement).value;
                      if (v) void refAction({ action: 'attach', ref: v, shot: shot.id }, `ref:${shot.id}`);
                    }}>
                    <option value="">+ attach from library…</option>
                    {attachable.map((r) => <option value={r.id}>{r.name ?? r.filename}</option>)}
                  </select>
                )}
                <label class={`btn small ghost ws-upload ${busy[`upload:${shot.id}`] ? 'running' : ''}`}>
                  {busy[`upload:${shot.id}`] ? 'Uploading…' : <><I name="upload" />Upload for this shot</>}
                  <input type="file" accept="image/png,image/jpeg,image/webp" multiple
                    onChange={(e) => { const inp = e.target as HTMLInputElement; void upload(inp.files, shot.id); inp.value = ''; }} />
                </label>
              </div>
            </div>

            <div class="ws-takes">
              {visible.length === 0 && <p class="sub">No takes yet — hit Re-shoot above, or Run all.</p>}
              <div class="takes-grid">
                {visible.map((t) => {
                  const liveTake = LIVE.includes(t.status);
                  const elapsed = liveTake ? Math.max(0, Math.round((now - Date.parse(t.created_at)) / 1000)) : null;
                  return (
                    <figure class={`take${t.picked ? ' picked' : ''}${t.superseded ? ' superseded' : ''}`}>
                      {t.picked && <span class="pick-chip">PICK</span>}
                      {!t.picked && t.superseded && <span class="old-chip">SUPERSEDED</span>}
                      {t.status === 'succeeded' && t.card_key ? (
                        <a href={`/img/${t.card_key}`} target="_blank">
                          <img src={`/img/${t.thumb_key ?? t.card_key}`} alt={`${t.model_alias} take`} loading="lazy" width={640} height={336} />
                        </a>
                      ) : (
                        <div class="take-hold">
                          <span class={`status ${t.status}`}>{t.status}</span>
                          {elapsed !== null && <span class="mono ws-elapsed">{elapsed}s</span>}
                          {t.status === 'failed' && (
                            <span class="take-err">{t.error_kind}: {(t.error_message ?? '').slice(0, 160)}</span>
                          )}
                        </div>
                      )}
                      <figcaption>
                        <span class="mono">{t.model_alias}</span>
                        {multiStyle && <span class="ws-take-style">{styleName(t.style_id)}</span>}
                        <span class="mono faint">#{t.iteration}</span>
                        {t.cost_micros > 0 && <span class="money">{usd(t.cost_micros)}</span>}
                        {t.duration_ms != null && <span class="mono faint">{Math.round(t.duration_ms / 1000)}s</span>}
                        {['succeeded', 'failed'].includes(t.status) && (
                          <span class="ws-take-actions">
                            {t.status === 'succeeded' && !t.picked && (
                              <button class="btn small" onClick={() => takeAction(t.id, 'pick')}><I name="pick" />Pick</button>
                            )}
                            {!t.superseded && (
                              <button class={`btn small ghost ${busy[`reroll:${t.id}`] ? 'running' : ''}`}
                                disabled={busy[`reroll:${t.id}`]} onClick={() => takeAction(t.id, 'reroll')}>
                                {busy[`reroll:${t.id}`] ? 'Rolling…' : <><I name="reroll" />Re-roll</>}
                              </button>
                            )}
                            {!t.picked && (
                              <button class="btn small ghost" onClick={() => takeAction(t.id, 'hide')}><I name="hide" />Hide</button>
                            )}
                          </span>
                        )}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
              {hidden.length > 0 && (
                <details class="ws-hidden">
                  <summary class="mono">{hidden.length} hidden</summary>
                  <div class="takes-grid">
                    {hidden.map((t) => (
                      <figure class="take dimmed">
                        {t.thumb_key && <img src={`/img/${t.thumb_key}`} alt="" loading="lazy" width={640} height={336} />}
                        <figcaption>
                          <span class="mono">{t.model_alias}</span>
                          <button class="btn small ghost" onClick={() => takeAction(t.id, 'unhide')}><I name="watch" />Unhide</button>
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </section>
        );
      })}

      <section class="card ws-shot">
        <header class="ws-shot-head"><b>Add a shot</b></header>
        <div class="ws-fields">
          <label class="field"><span>Label</span>
            <input type="text" value={addLabel} placeholder="optional"
              onInput={(e) => setAddLabel((e.target as HTMLInputElement).value)} /></label>
          <label class="field"><span>What is happening</span>
            <textarea value={addPrompt} rows={3}
              onInput={(e) => setAddPrompt((e.target as HTMLTextAreaElement).value)} /></label>
        </div>
        <button class={`btn small ${busy['add-shot'] ? 'running' : ''}`} disabled={busy['add-shot']} onClick={addShot}>
          {busy['add-shot'] ? 'Adding…' : <><I name="add" />Add shot</>}
        </button>
      </section>

      <section class="card ws-shot">
        <header class="ws-shot-head"><b>Reference photos on EVERY shot</b>
          <span class="ws-sub-inline">
            One clear photo of a face is enough to keep it consistent; a second angle helps.
            Single-reference models only ever see the FIRST image — put the important one first.
          </span>
        </header>
        <div class="ws-ref-strip big">
          {refs.project.map((r) => (
            <figure class="ws-ref" title={r.name ?? r.filename}>
              <img src={`/img/${r.r2_key}`} alt="" loading="lazy" />
              <figcaption>
                <span class="ws-ref-name">{r.name ?? r.filename}</span>
                <button class="linkish" onClick={() => refAction({ action: 'remove', ref: r.id }, 'ref:project')}>✕ remove</button>
              </figcaption>
            </figure>
          ))}
          {refs.library
            .filter((r) => !refs.project.some((x) => x.id === r.id))
            .map((r) => (
              <figure class="ws-ref dim" title={r.name ?? r.filename}>
                <img src={`/img/${r.r2_key}`} alt="" loading="lazy" />
                <figcaption>
                  <span class="ws-ref-name">{r.name ?? r.filename}</span>
                  <button class="linkish" onClick={() => refAction({ action: 'attach', ref: r.id }, 'ref:project')}>+ every shot</button>
                </figcaption>
              </figure>
            ))}
          <label class={`btn small ghost ws-upload ${busy['upload'] ? 'running' : ''}`}>
            {busy['upload'] ? 'Uploading…' : <><I name="upload" />Upload — attaches to every shot</>}
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple
              onChange={(e) => { const inp = e.target as HTMLInputElement; void upload(inp.files); inp.value = ''; }} />
          </label>
        </div>
        {(refs.project.length > 0 || Object.keys(refs.shots).length > 0) && (
          <div class="ws-role">
            <label class="field">
              <span>Who is the reference person in the scene? Needed whenever a scene has more than one person — models guess, and they guess differently.</span>
              <input type="text" value={projRole} placeholder='e.g. "the interviewer"'
                onInput={(e) => { setProjRole((e.target as HTMLInputElement).value); setRoleState('dirty'); }} />
            </label>
            <button class="btn small ghost" onClick={saveRole}>
              {roleState === 'saved' ? 'Saved ✓' : roleState === 'saving' ? 'Saving…' : 'Save role'}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
