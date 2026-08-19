/**
 * The per-shot editor island (round 4): one shot's prompt, styles, references
 * and contact sheet on its own page. Keeps every round-3 invariant: autosave
 * with a visible badge, actions flush pending saves first, the poll never
 * clobbers a draft, hold-to-confirm for destruction. Modals are for previews
 * and pickers ONLY.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import type { TakesPayload, WsShot, WsTake } from '../../lib/workspace';
import type { RefState } from '../../lib/media';
import {
  BADGE, CHAIN, HoldButton, I, LIVE, Modal, makeApi, toJpeg, usd,
  type ModelRef, type SaveState,
} from './lib';

export interface EditorStyle {
  id: string;
  name: string;
  description: string;
  house: boolean;
  thumb: string | null;
  scene: string | null;
}

export interface EditorInitial {
  slug: string;
  shotId: string;
  projectName: string;
  iterations: number;
  perCellMicros: number;
  styles: EditorStyle[];
  projectStyleIds: string[];
  primaryStyleId: string;
  modelRefs: ModelRef[];
  takes: TakesPayload;
  refs: RefState;
}

interface Draft {
  label: string;
  prompt: string;
  role: string;
  state: SaveState;
}

/** A take is "stuck" once it has been live this long — offer a way out. */
const STUCK_MS = 3 * 60_000;

export default function ShotEditor({ initial }: { initial: EditorInitial }) {
  const { slug, shotId, projectStyleIds } = initial;
  const api = makeApi(slug);

  const [shots, setShots] = useState<WsShot[]>(initial.takes.shots);
  const [takes, setTakes] = useState<WsTake[]>(initial.takes.takes);
  const [live, setLive] = useState(initial.takes.live);
  const [refs, setRefs] = useState<RefState>(initial.refs);
  const shot0 = initial.takes.shots.find((s) => s.id === shotId)!;
  const [draft, setDraft] = useState<Draft>({
    label: shot0.label ?? '',
    prompt: shot0.prompt,
    role: shot0.ref_role ?? '',
    state: 'saved',
  });
  const [suggestions, setSuggestions] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [lightbox, setLightbox] = useState<WsTake | null>(null);
  const [stylePicker, setStylePicker] = useState(false);
  const [libPicker, setLibPicker] = useState(false);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const timer = useRef<number>();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLDivElement>(null);

  const shot = shots.find((s) => s.id === shotId) ?? shot0;
  const styleById = new Map(initial.styles.map((s) => [s.id, s]));

  // ---------- autosave (the round-3 headline, kept verbatim in spirit) ----------
  const save = async () => {
    const d = draftRef.current;
    if (d.state !== 'dirty' && d.state !== 'error') return;
    if (!d.prompt.trim()) {
      setDraft((x) => ({ ...x, state: 'empty' }));
      return;
    }
    const sent = { prompt: d.prompt, label: d.label, refRole: d.role };
    setDraft((x) => ({ ...x, state: 'saving' }));
    try {
      await api.post('/shots', { action: 'edit', shot: shotId, ...sent });
      const cur = draftRef.current;
      const clean = cur.prompt === sent.prompt && cur.label === sent.label && cur.role === sent.refRole;
      setDraft((x) => ({ ...x, state: clean ? 'saved' : 'dirty' }));
      setShots((prev) =>
        prev.map((s) =>
          s.id === shotId
            ? { ...s, prompt: sent.prompt, label: sent.label || null, ref_role: sent.refRole || null }
            : s,
        ),
      );
      if (!clean) schedule();
    } catch {
      setDraft((x) => ({ ...x, state: 'error' }));
      window.setTimeout(() => {
        if (draftRef.current.state === 'error') {
          setDraft((x) => ({ ...x, state: 'dirty' }));
          void save();
        }
      }, 3000);
    }
  };
  const schedule = () => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), 800);
  };
  const edit = (patch: Partial<Pick<Draft, 'label' | 'prompt' | 'role'>>) => {
    setDraft((x) => ({ ...x, ...patch, state: 'dirty' }));
    schedule();
  };
  const flush = async () => {
    clearTimeout(timer.current);
    await save();
  };

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (draftRef.current.state !== 'saved') e.preventDefault();
    };
    addEventListener('beforeunload', h);
    return () => removeEventListener('beforeunload', h);
  }, []);

  // ---------- poll (never touches the draft) ----------
  const refresh = async () => {
    const p = (await api.call('/takes')) as unknown as TakesPayload;
    setTakes(p.takes);
    setLive(p.live);
    setShots((prev) => {
      const mine = prev.find((s) => s.id === shotId);
      return p.shots.map((srv) =>
        srv.id === shotId && mine ? { ...srv, prompt: mine.prompt, label: mine.label, ref_role: mine.ref_role } : srv,
      );
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

  // ---------- actions ----------
  const reshoot = () =>
    withBusy('reshoot', async () => {
      await flush();
      await api.post('/shots', { action: 'reshoot', shot: shotId });
      await refresh();
    });

  const suggest = () =>
    withBusy('suggest', async () => {
      await flush();
      const r = (await api.post('/shots', { action: 'suggest', shot: shotId })) as { variants: string[] };
      setSuggestions(r.variants);
      setTimeout(() => document.getElementById('sugg')?.scrollIntoView({ block: 'center' }), 50);
    });

  const useVariant = (text: string, mode: 'replace' | 'append') => {
    edit({ prompt: mode === 'replace' ? text : `${draftRef.current.prompt.trimEnd()}\n${text}` });
    setSuggestions(null);
  };

  const setStyle = (styleId: string) =>
    withBusy('style', async () => {
      await flush();
      await api.post('/shots', { action: 'set-style', shot: shotId, style: styleId });
      setShots((prev) => prev.map((s) => (s.id === shotId ? { ...s, style_override_id: styleId || null } : s)));
      setStylePicker(false);
    });

  const takeAction = (takeId: string, action: 'pick' | 'hide' | 'unhide' | 'reroll' | 'giveup') =>
    withBusy(`${action}:${takeId}`, async () => {
      await api.post('/takes', { action, take: takeId });
      setLightbox(null);
      await refresh();
    });

  const deleteShot = () =>
    withBusy('delete', async () => {
      await api.post('/shots', { action: 'delete', shot: shotId });
      location.href = `/projects/${slug}/shots`;
    });

  const refAction = (body: Record<string, unknown>, key = 'ref') =>
    withBusy(key, async () => {
      const r = (await api.post('/refs', body)) as unknown as RefState;
      setRefs(r);
    });

  const upload = (files: FileList | null) =>
    withBusy('upload', async () => {
      if (!files?.length) return;
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append('photos', await toJpeg(f), f.name);
      fd.append('shot', shotId);
      const res = await fetch(`/api/projects/${slug}/refs`, { method: 'POST', body: fd });
      const data = (await res.json()) as RefState & { errors?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (data.errors?.length) setError(data.errors.join(' '));
      setRefs(data);
    });

  // ---------- derived ----------
  const myTakes = takes
    .filter((t) => t.shot_id === shotId)
    .sort(
      (a, b) =>
        a.model_alias.localeCompare(b.model_alias) ||
        a.iteration - b.iteration ||
        Number(a.superseded) - Number(b.superseded) ||
        b.created_at.localeCompare(a.created_at),
    );
  const visible = myTakes.filter((t) => !t.hidden);
  const hidden = myTakes.filter((t) => t.hidden);
  const multiStyle = projectStyleIds.length > 1;
  const styleName = (id: string) => styleById.get(id)?.name ?? 'style';
  const stylesFor = shot.style_override_id ? 1 : Math.max(projectStyleIds.length, 1);
  const perShot = stylesFor * initial.iterations * initial.perCellMicros;
  const [badgeCls, badgeText] = BADGE[draft.state];

  const shotRefs = refs.shots[shotId] ?? [];
  const chainTargets = (() => {
    const out: number[] = [];
    for (const m of draft.prompt.matchAll(CHAIN)) {
      const n = Number(m[1]);
      if (!out.includes(n)) out.push(n);
    }
    return out;
  })();
  const chainProblem = (n: number) => {
    const t = shots.find((s) => s.position === n);
    if (!t) return `there is no shot ${n}`;
    if (t.id === shotId) return 'a shot cannot chain itself';
    if (!t.picked_take_id) return `shot ${n} has no picked take yet`;
    return null;
  };
  /** Numbered exactly as models receive them: chain first, then this shot's, then project-wide. */
  const numberedRefs: { n: number; img: string | null; label: string; kind: string; refId?: string }[] = [];
  {
    let n = 1;
    for (const c of chainTargets) {
      const t = shots.find((s) => s.position === c);
      const pick = t?.picked_take_id ? takes.find((x) => x.id === t.picked_take_id) : null;
      numberedRefs.push({
        n: n++,
        img: pick?.art_thumb_key ?? pick?.art_key ?? null,
        label: `{shot ${c}} — its picked take`,
        kind: chainProblem(c) ? 'warn' : 'chain',
      });
    }
    for (const r of shotRefs)
      numberedRefs.push({ n: n++, img: r.r2_key, label: `${r.name ?? r.filename} (this shot)`, kind: 'shot', refId: r.id });
    for (const r of refs.project)
      numberedRefs.push({ n: n++, img: r.r2_key, label: `${r.name ?? r.filename} (every shot)`, kind: 'project' });
  }

  const refCapable = initial.modelRefs.filter((m) => m.refStyle !== 'none');
  const refBlind = initial.modelRefs.filter((m) => m.refStyle === 'none');
  const projectStyles = initial.styles.filter((s) => projectStyleIds.includes(s.id));
  const overrideOutside =
    shot.style_override_id && !projectStyleIds.includes(shot.style_override_id)
      ? styleById.get(shot.style_override_id)
      : null;
  const attachable = refs.library.filter(
    (r) => !shotRefs.some((x) => x.id === r.id) && !refs.project.some((x) => x.id === r.id),
  );

  // ---------- {shot N} highlight overlay ----------
  const syncScroll = () => {
    if (backRef.current && taRef.current) backRef.current.scrollTop = taRef.current.scrollTop;
  };
  const autoHeight = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(104, ta.scrollHeight)}px`;
    if (backRef.current) backRef.current.style.height = ta.style.height;
  };
  useEffect(autoHeight, [draft.prompt]);
  const highlighted = (() => {
    const parts: ComponentChildren[] = [];
    let last = 0;
    for (const m of draft.prompt.matchAll(CHAIN)) {
      parts.push(draft.prompt.slice(last, m.index));
      const bad = chainProblem(Number(m[1]));
      parts.push(<mark class={bad ? 'tok warn' : 'tok'}>{m[0]}</mark>);
      last = m.index! + m[0].length;
    }
    parts.push(draft.prompt.slice(last));
    parts.push('\n'); // trailing newline keeps the last line's height honest
    return parts;
  })();

  const isStuck = (t: WsTake) =>
    LIVE.includes(t.status) && now - Date.parse(t.created_at) > STUCK_MS;

  // ---------- render ----------
  return (
    <div class="ws">
      {error && <p class="flash">{error}</p>}
      {takes.some((t) => t.error_kind === 'throttled') && (
        <p class="flash">Replicate is throttling — this usually means the account balance is under $5, not a bug.</p>
      )}

      <section class="card ws-shot">
        <header class="ws-shot-head">
          <span class="mono ws-pos">{shot.position}</span>
          <b>{draft.label || `Shot ${shot.position}`}</b>
          {shot.style_override_id && <em class="chip ws-style-chip">{styleName(shot.style_override_id)}</em>}
          <span class={badgeCls}>{badgeText}</span>
          <button
            class={`btn small ws-right ${busy.reshoot ? 'running' : ''}`}
            disabled={busy.reshoot}
            title="New takes of this shot with today's prompt and styles — the old ones stay"
            onClick={reshoot}
          >
            {busy.reshoot ? 'Starting…' : <><I name="reshoot" />Re-shoot · {usd(perShot)}</>}
          </button>
        </header>

        <div class="ws-fields">
          <label class="field"><span>Label</span>
            <input type="text" value={draft.label}
              onInput={(e) => edit({ label: (e.target as HTMLInputElement).value })} />
          </label>
          <label class="field"><span>What is happening — never a medium, never a palette. {'{shot 1}'} carries shot 1's picked character into this shot.</span>
            <span class="ws-hl-wrap">
              <div class="ws-hl-back" aria-hidden ref={backRef}>{highlighted}</div>
              <textarea
                ref={taRef}
                class="ws-hl-ta"
                value={draft.prompt}
                onInput={(e) => { edit({ prompt: (e.target as HTMLTextAreaElement).value }); autoHeight(); }}
                onScroll={syncScroll}
              />
            </span>
          </label>
          {chainTargets.map((n) => {
            const bad = chainProblem(n);
            return (
              <p class={`ws-chain ${bad ? 'warn' : ''}`}>
                {bad ? `⚠ {shot ${n}}: ${bad}` : `⛓ {shot ${n}} rides along as reference image ${chainTargets.indexOf(n) + 1}`}
              </p>
            );
          })}
          <label class="field"><span>Who is the reference person in THIS shot (blank = the project's answer)</span>
            <input type="text" value={draft.role} placeholder='e.g. "the interviewer"'
              onInput={(e) => edit({ role: (e.target as HTMLInputElement).value })} />
          </label>
        </div>

        <div class="ws-row">
          <button class={`btn small ghost ${busy.suggest ? 'running' : ''}`} disabled={busy.suggest} onClick={suggest}>
            {busy.suggest ? 'Writing…' : <><I name="cowrite" />Co-write — expand this idea</>}
          </button>
          <HoldButton label={<><I name="delete" />Delete shot</>} confirm="sure? hold to delete" onFire={deleteShot} />
        </div>

        {suggestions && (
          <div class="ws-suggestions" id="sugg">
            <p class="kicker"><span class="g">/</span>Co-writer — your idea written out long; nothing changes until you approve one</p>
            {suggestions.map((v) => (
              <div class="ws-suggestion">
                <p>{v}</p>
                <div class="ws-sugg-actions">
                  <button class="btn small" onClick={() => useVariant(v, 'replace')}>Use this</button>
                  <button class="btn small ghost" onClick={() => useVariant(v, 'append')}>Append</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div class="ws-styles">
          <span class="ws-mini">Style — this shot only; the project set is chosen in Settings</span>
          <div class="ws-style-strip">
            <button type="button" class={`ws-style-opt ${!shot.style_override_id ? 'on' : ''}`}
              onClick={() => setStyle('')}
              title={multiStyle ? `the project's ${projectStyleIds.length} styles` : 'the project style'}>
              {styleById.get(initial.primaryStyleId)?.thumb
                ? <img src={`/img/${styleById.get(initial.primaryStyleId)!.thumb}`} alt="" loading="lazy" />
                : <span class="ws-style-ph">project</span>}
              <span>project{multiStyle ? ` (${projectStyleIds.length})` : ''}</span>
            </button>
            {projectStyles.map((st) => (
              <button type="button" class={`ws-style-opt ${st.id === shot.style_override_id ? 'on' : ''}`}
                onClick={() => setStyle(st.id)} title={st.name}>
                {st.thumb ? <img src={`/img/${st.thumb}`} alt="" loading="lazy" /> : <span class="ws-style-ph">{st.name}</span>}
                <span>{st.name}</span>
              </button>
            ))}
            {overrideOutside && (
              <button type="button" class="ws-style-opt on" title={overrideOutside.name}>
                {overrideOutside.thumb ? <img src={`/img/${overrideOutside.thumb}`} alt="" /> : <span class="ws-style-ph">{overrideOutside.name}</span>}
                <span>{overrideOutside.name}</span>
              </button>
            )}
            <button type="button" class="ws-style-opt ws-style-more" onClick={() => setStylePicker(true)}>
              <span class="ws-style-ph">···</span>
              <span>All styles…</span>
            </button>
          </div>
        </div>

        <div class="ws-refs">
          <span class="ws-mini">Reference photos</span>
          {refCapable.length === 0 ? (
            <p class="ws-ref-note">
              None of this project's models ({refBlind.map((m) => m.alias).join(', ')}) look at
              reference photos — pick one that does (nano2, seedream, gpt2, flux2…) in{' '}
              <a href={`/projects/${slug}/settings`}>Settings</a> to use them.
            </p>
          ) : (
            <>
              <div class="ws-ref-strip">
                {numberedRefs.map((r) => (
                  <figure class={`ws-ref ${r.kind === 'project' ? 'every' : ''} ${r.kind === 'warn' ? 'warn' : ''}`} title={r.label}>
                    {r.img ? <img src={`/img/${r.img}`} alt="" loading="lazy" /> : <span class="ws-ref-hole">?</span>}
                    <figcaption>
                      <b>image {r.n}</b>
                      {r.refId && (
                        <button class="linkish" title="Detach from this shot"
                          onClick={() => refAction({ action: 'remove', ref: r.refId, shot: shotId })}>✕</button>
                      )}
                    </figcaption>
                  </figure>
                ))}
                <button type="button" class="btn small ghost" onClick={() => setLibPicker(true)}>
                  <I name="media" />Attach from library
                </button>
                <label class={`btn small ghost ws-upload ${busy.upload ? 'running' : ''}`}>
                  {busy.upload ? 'Uploading…' : <><I name="upload" />Upload for this shot</>}
                  <input type="file" accept="image/png,image/jpeg,image/webp" multiple
                    onChange={(e) => { const inp = e.target as HTMLInputElement; void upload(inp.files); inp.value = ''; }} />
                </label>
              </div>
              <p class="ws-ref-note">
                Models receive these in the numbered order — <b>single-image models only ever see image 1</b>.
                You never name a photo in the prompt: write "the reference person" (or fill the role field
                above), and use {'{shot N}'} to chain another shot's picked character in as image 1.
                Seen by {refCapable.map((m) => `${m.alias} (up to ${m.maxRefs})`).join(', ')}
                {refBlind.length > 0 && <>; ignored by {refBlind.map((m) => m.alias).join(', ')}</>}.
              </p>
            </>
          )}
        </div>

        <div class="ws-takes">
          {visible.length === 0 && <p class="sub">No takes yet — hit Re-shoot above.</p>}
          <div class="takes-grid">
            {visible.map((t) => {
              const liveTake = LIVE.includes(t.status);
              const elapsed = liveTake ? Math.max(0, Math.round((now - Date.parse(t.created_at)) / 1000)) : null;
              const thumb = t.art_thumb_key ?? t.art_key ?? t.thumb_key ?? t.card_key;
              return (
                <figure class={`take${t.picked ? ' picked' : ''}${t.superseded ? ' superseded' : ''}`}>
                  {t.picked && <span class="pick-chip">PICK</span>}
                  {!t.picked && t.superseded && <span class="old-chip">SUPERSEDED</span>}
                  {t.status === 'succeeded' && thumb ? (
                    <button type="button" class="ws-take-open" onClick={() => setLightbox(t)}>
                      <img src={`/img/${thumb}`} alt={`${t.model_alias} take`} loading="lazy" width={640} height={360} />
                    </button>
                  ) : (
                    <div class="take-hold">
                      <span class={`status ${t.status}`}>{t.status}</span>
                      {elapsed !== null && <span class="mono ws-elapsed">{elapsed}s</span>}
                      {t.status === 'failed' && (
                        <span class="take-err">{t.error_kind}: {(t.error_message ?? '').slice(0, 160)}</span>
                      )}
                      {isStuck(t) && (
                        <span class="ws-row">
                          <HoldButton label="Give up on this take" confirm="sure? hold"
                            onFire={() => takeAction(t.id, 'giveup')} />
                        </span>
                      )}
                    </div>
                  )}
                  <figcaption>
                    <span class="mono ws-ordinal">{shot.position}.{t.ordinal}</span>
                    <span class="mono">{t.model_alias}</span>
                    {multiStyle && <span class="ws-take-style">{styleName(t.style_id)}</span>}
                    <span class="mono faint">#{t.iteration}</span>
                    {t.cost_micros > 0 && <span class="money">{usd(t.cost_micros)}</span>}
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
                    {(t.art_thumb_key ?? t.thumb_key) && (
                      <img src={`/img/${t.art_thumb_key ?? t.thumb_key}`} alt="" loading="lazy" width={640} height={360} />
                    )}
                    <figcaption>
                      <span class="mono ws-ordinal">{shot.position}.{t.ordinal}</span>
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

      {/* take lightbox: the RAW picture big; the branded card is one click away */}
      <Modal open={!!lightbox} onClose={() => setLightbox(null)} wide
        title={lightbox ? `${shot.position}.${lightbox.ordinal} · ${lightbox.model_alias} · #${lightbox.iteration}${multiStyle ? ` · ${styleName(lightbox.style_id)}` : ''}` : ''}>
        {lightbox && (
          <div class="ws-lightbox">
            <img src={`/img/${lightbox.art_key ?? lightbox.card_key}`} alt="take" />
            <div class="ws-row">
              {lightbox.art_key && (
                <a class="btn small" href={`/img/${lightbox.art_key}`} download={`${slug}-shot${shot.position}-raw.png`}>
                  <I name="download" />Download raw
                </a>
              )}
              {lightbox.card_key && (
                <a class="btn small ghost" href={`/img/${lightbox.card_key}`} download={`${slug}-shot${shot.position}-card.png`}>
                  <I name="download" />Download card
                </a>
              )}
              {lightbox.card_key && (
                <a class="btn small ghost" href={`/img/${lightbox.card_key}`} target="_blank"><I name="watch" />View card</a>
              )}
              {!lightbox.picked && lightbox.status === 'succeeded' && (
                <button class="btn small" onClick={() => takeAction(lightbox.id, 'pick')}><I name="pick" />Pick</button>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* all-styles picker */}
      <Modal open={stylePicker} onClose={() => setStylePicker(false)} wide title="Pick a style for this shot">
        <div class="ws-pick-grid">
          <button type="button" class={`ws-pick-card ${!shot.style_override_id ? 'on' : ''}`} onClick={() => setStyle('')}>
            <b>Project styles</b>
            <span class="ws-pick-desc">back to the {projectStyleIds.length} style{projectStyleIds.length === 1 ? '' : 's'} chosen in Settings</span>
          </button>
          {initial.styles.map((st) => (
            <button type="button" class={`ws-pick-card ${st.id === shot.style_override_id ? 'on' : ''}`} onClick={() => setStyle(st.id)}>
              <span class="ws-pick-imgs">
                {st.thumb && <img src={`/img/${st.thumb}`} alt="" loading="lazy" />}
                {st.scene && <img src={`/img/${st.scene}`} alt="" loading="lazy" />}
              </span>
              <b>{st.name}{st.house ? ' · house' : ''}</b>
              <span class="ws-pick-desc">{st.description}</span>
            </button>
          ))}
        </div>
      </Modal>

      {/* library picker */}
      <Modal open={libPicker} onClose={() => setLibPicker(false)} wide title="Attach a photo to this shot">
        {attachable.length === 0 ? (
          <p class="sub">Everything in the <a href="/media">library</a> is already attached — upload something new.</p>
        ) : (
          <div class="ws-pick-grid">
            {attachable.map((r) => (
              <button type="button" class="ws-pick-card"
                onClick={() => { void refAction({ action: 'attach', ref: r.id, shot: shotId }); setLibPicker(false); }}>
                <span class="ws-pick-imgs"><img src={`/img/${r.r2_key}`} alt="" loading="lazy" /></span>
                <b>{r.name ?? r.filename}</b>
                <span class="ws-pick-desc mono">{r.width}×{r.height}</span>
              </button>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
