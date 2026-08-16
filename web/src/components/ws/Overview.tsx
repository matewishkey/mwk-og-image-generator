/**
 * The project overview island (round 4): one light row per shot — the heavy
 * editing lives on each shot's own page. Project-level concerns (run-all,
 * add-a-shot, EVERY-shot reference photos, the reference role) live here.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { TakesPayload, WsShot, WsTake } from '../../lib/workspace';
import type { RefState } from '../../lib/media';
import { HoldButton, I, LIVE, Modal, makeApi, toJpeg, usd, type ModelRef } from './lib';

export interface OverviewInitial {
  slug: string;
  projectName: string;
  iterations: number;
  perCellMicros: number;
  maxSeconds: number;
  projectStyleIds: string[];
  styleNames: Record<string, string>;
  modelRefs: ModelRef[];
  refRole: string | null;
  takes: TakesPayload;
  refs: RefState;
}

export default function Overview({ initial }: { initial: OverviewInitial }) {
  const { slug, iterations, projectStyleIds } = initial;
  const api = makeApi(slug);

  const [shots, setShots] = useState<WsShot[]>(initial.takes.shots);
  const [takes, setTakes] = useState<WsTake[]>(initial.takes.takes);
  const [spent, setSpent] = useState(initial.takes.spentMicros);
  const [live, setLive] = useState(initial.takes.live);
  const [refs, setRefs] = useState<RefState>(initial.refs);
  const [role, setRole] = useState(initial.refRole ?? '');
  const [roleState, setRoleState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [addPrompt, setAddPrompt] = useState('');
  const [libPicker, setLibPicker] = useState(false);

  const refresh = async () => {
    const p = (await api.call('/takes')) as unknown as TakesPayload;
    setShots(p.shots);
    setTakes(p.takes);
    setSpent(p.spentMicros);
    setLive(p.live);
  };
  useEffect(() => {
    if (!live) return;
    const poll = window.setInterval(() => void refresh().catch(() => {}), 3000);
    return () => clearInterval(poll);
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

  const runAll = () =>
    withBusy('run-all', async () => {
      await api.post('/run', {});
      await refresh();
    });
  const reshoot = (id: string) =>
    withBusy(`reshoot:${id}`, async () => {
      await api.post('/shots', { action: 'reshoot', shot: id });
      await refresh();
    });
  const addShot = () =>
    withBusy('add-shot', async () => {
      if (!addPrompt.trim()) throw new Error('The new shot needs a prompt.');
      const r = (await api.post('/shots', { action: 'add', prompt: addPrompt, label: addLabel })) as { position: number };
      setAddLabel('');
      setAddPrompt('');
      // Straight into the new shot's editor — that is where the work happens.
      location.href = `/projects/${slug}/shots/${r.position}`;
    });
  const refAction = (body: Record<string, unknown>) =>
    withBusy('ref', async () => {
      const r = (await api.post('/refs', body)) as unknown as RefState;
      setRefs(r);
    });
  const saveRole = () =>
    withBusy('role', async () => {
      setRoleState('saving');
      await api.post('/refs', { action: 'role', refRole: role });
      setRoleState('saved');
    });
  const upload = (files: FileList | null) =>
    withBusy('upload', async () => {
      if (!files?.length) return;
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append('photos', await toJpeg(f), f.name);
      const res = await fetch(`/api/projects/${slug}/refs`, { method: 'POST', body: fd });
      const data = (await res.json()) as RefState & { errors?: string[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (data.errors?.length) setError(data.errors.join(' '));
      setRefs(data);
    });

  const stylesFor = (s: WsShot) => (s.style_override_id ? 1 : Math.max(projectStyleIds.length, 1));
  const cellsAll = shots.reduce((n, s) => n + stylesFor(s) * iterations, 0);
  const estAll = cellsAll * initial.perCellMicros;
  const estTime = (() => {
    if (!initial.maxSeconds) return '';
    const secs = initial.maxSeconds * Math.ceil(cellsAll / 4);
    return secs < 90 ? ` · ~${secs}s` : ` · ~${Math.round(secs / 60)} min`;
  })();
  const pickedCount = shots.filter((s) => s.picked_take_id).length;
  const refCapable = initial.modelRefs.filter((m) => m.refStyle !== 'none');
  const attachable = refs.library.filter((r) => !refs.project.some((x) => x.id === r.id));

  const rowFor = (shot: WsShot) => {
    const mine = takes.filter((t) => t.shot_id === shot.id && !t.hidden);
    const liveN = mine.filter((t) => LIVE.includes(t.status)).length;
    const failedN = mine.filter((t) => t.status === 'failed').length;
    const okN = mine.filter((t) => t.status === 'succeeded').length;
    const pick = shot.picked_take_id ? takes.find((t) => t.id === shot.picked_take_id) : null;
    const newest = mine.find((t) => t.status === 'succeeded');
    const thumbTake = pick ?? newest;
    const thumb = thumbTake ? thumbTake.art_thumb_key ?? thumbTake.art_key ?? thumbTake.thumb_key : null;
    const shotRefN = (refs.shots[shot.id] ?? []).length;
    return (
      <a class="list-row ws-orow" href={`/projects/${slug}/shots/${shot.position}`}>
        <span class="list-thumb">
          {thumb ? <img src={`/img/${thumb}`} alt="" loading="lazy" /> : <span class="list-ph">no take yet</span>}
        </span>
        <span class="list-body">
          <span class="list-name">
            <span class="mono ws-pos">{shot.position}</span> {shot.label ?? `Shot ${shot.position}`}
            {shot.style_override_id && (
              <em class="chip ws-style-chip">{initial.styleNames[shot.style_override_id] ?? 'own style'}</em>
            )}
            {pick && <em class="chip">picked</em>}
          </span>
          <span class="list-desc">{shot.prompt.length > 150 ? `${shot.prompt.slice(0, 150)}…` : shot.prompt}</span>
          <span class="list-meta mono">
            {okN} take{okN === 1 ? '' : 's'}
            {liveN > 0 && <span class="ws-live-chip"> · {liveN} rendering…</span>}
            {failedN > 0 && <span class="ws-fail-chip"> · {failedN} failed</span>}
            {shotRefN > 0 && ` · ${shotRefN} own ref${shotRefN === 1 ? '' : 's'}`}
          </span>
        </span>
        <span class="list-actions" onClick={(e) => e.preventDefault()}>
          <button
            class={`btn small ghost ${busy[`reshoot:${shot.id}`] ? 'running' : ''}`}
            disabled={busy[`reshoot:${shot.id}`]}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); void reshoot(shot.id); }}
          >
            {busy[`reshoot:${shot.id}`] ? 'Starting…' : <><I name="reshoot" />Re-shoot · {usd(stylesFor(shot) * iterations * initial.perCellMicros)}</>}
          </button>
          <span class="btn small"><I name="edit" />Open</span>
        </span>
      </a>
    );
  };

  return (
    <div class="ws">
      {error && <p class="flash">{error}</p>}
      {takes.some((t) => t.error_kind === 'throttled') && (
        <p class="flash">Replicate is throttling — this usually means the account balance is under $5, not a bug.</p>
      )}

      <div class="ws-top">
        <p class="sub">
          Spent so far: <span class="money">{usd(spent)}</span> · {pickedCount}/{shots.length} picked
          {projectStyleIds.length > 1 && <> · {projectStyleIds.length} styles per shot</>}
        </p>
        <button class={`btn ${busy['run-all'] ? 'running' : ''}`} disabled={!shots.length || busy['run-all']} onClick={runAll}>
          {busy['run-all']
            ? 'Starting the run…'
            : <><I name="run" />Run all {shots.length} shot{shots.length === 1 ? '' : 's'} · {usd(estAll)}{estTime}</>}
        </button>
      </div>

      <div class="list">{shots.map(rowFor)}</div>
      {shots.length === 0 && <p class="sub">No shots yet — add the first one below.</p>}

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
            Single-reference models only ever see the FIRST image. Per-shot photos live on each shot's page.
          </span>
        </header>
        {refCapable.length === 0 ? (
          <p class="ws-ref-note">
            None of this project's models ({initial.modelRefs.map((m) => m.alias).join(', ')}) look at
            reference photos — pick one that does (nano2, seedream, gpt2, flux2…) in{' '}
            <a href={`/projects/${slug}/settings`}>Settings</a> to use them.
          </p>
        ) : (
          <>
            <div class="ws-ref-strip big">
              {refs.project.map((r) => (
                <figure class="ws-ref" title={r.name ?? r.filename}>
                  <img src={`/img/${r.r2_key}`} alt="" loading="lazy" />
                  <figcaption>
                    <span class="ws-ref-name">{r.name ?? r.filename}</span>
                    <button class="linkish" onClick={() => refAction({ action: 'remove', ref: r.id })}>✕ remove</button>
                  </figcaption>
                </figure>
              ))}
              <button type="button" class="btn small ghost" onClick={() => setLibPicker(true)}>
                <I name="media" />Attach from library
              </button>
              <label class={`btn small ghost ws-upload ${busy.upload ? 'running' : ''}`}>
                {busy.upload ? 'Uploading…' : <><I name="upload" />Upload — attaches to every shot</>}
                <input type="file" accept="image/png,image/jpeg,image/webp" multiple
                  onChange={(e) => { const inp = e.target as HTMLInputElement; void upload(inp.files); inp.value = ''; }} />
              </label>
            </div>
            <div class="ws-role">
              <label class="field">
                <span>Who is the reference person in the scene? Needed whenever a scene has more than one person — models guess, and they guess differently.</span>
                <input type="text" value={role} placeholder='e.g. "the interviewer"'
                  onInput={(e) => { setRole((e.target as HTMLInputElement).value); setRoleState('dirty'); }} />
              </label>
              <button class="btn small ghost" onClick={saveRole}>
                {roleState === 'saved' ? 'Saved ✓' : roleState === 'saving' ? 'Saving…' : 'Save role'}
              </button>
            </div>
          </>
        )}
      </section>

      <Modal open={libPicker} onClose={() => setLibPicker(false)} wide title="Attach a photo to every shot">
        {attachable.length === 0 ? (
          <p class="sub">Everything in the <a href="/media">library</a> is already attached — upload something new.</p>
        ) : (
          <div class="ws-pick-grid">
            {attachable.map((r) => (
              <button type="button" class="ws-pick-card"
                onClick={() => { void refAction({ action: 'attach', ref: r.id }); setLibPicker(false); }}>
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
