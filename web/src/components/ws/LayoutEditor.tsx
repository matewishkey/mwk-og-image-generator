/**
 * The layout editor (round 4): structured knobs on the left, a LIVE preview on
 * the right — every change re-renders through the engine's inline mode against
 * the project's real picked images, for $0.00 and no persisted rows. Saving
 * goes through the existing author flow (a new layout row + a real design).
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { I, makeApi } from './lib';

const ARCHETYPES = ['hero', 'diptych', 'stack', 'triptych', 'mosaic', 'quad', 'filmstrip'];
const LOCKUPS = ['bottom', 'top', 'corner', 'inset', 'rail', 'none'];
const SEAMS = ['butt', 'hairline', 'feather'];
const TOKENS = ['paper', 'ink', 'mute', 'faint', 'red', 'redField', 'redDeep', 'line', 'onRed'];
const FONTS = ['title', 'kicker', 'tagline'];
const EDGES = ['left', 'right', 'top', 'bottom'];

type Cfg = Record<string, unknown> & {
  archetype?: string;
  cells?: Record<string, unknown>[];
  texts?: Record<string, unknown>[];
  shapes?: Record<string, unknown>[];
};

export interface EditorProps {
  slug: string;
  layouts: { id: string; name: string; config: string }[];
  formats: { id: string; name: string; width: number; height: number }[];
  defaults: { title: string; kicker: string; tagline: string };
  initialConfig: Cfg;
  initialName: string;
  kitHasDark: boolean;
  pickCount: number;
  /** The design page's working scope, carried through so the editor shows the SAME picture. */
  scope: { shot: number | null; style: string | null };
  initialFormatId?: string;
  initialTheme: 'light' | 'dark';
  initialEffect: string;
}

export default function LayoutEditor(p: { initial: EditorProps }) {
  const { slug, layouts, formats, defaults, kitHasDark, pickCount, scope } = p.initial;
  const api = makeApi(slug);

  const [cfg, setCfg] = useState<Cfg>(p.initial.initialConfig);
  const [name, setName] = useState(p.initial.initialName);
  const [formatId, setFormatId] = useState(p.initial.initialFormatId ?? formats[0]?.id ?? '');
  const [title, setTitle] = useState(defaults.title);
  const [kicker, setKicker] = useState(defaults.kicker);
  const [tagline, setTagline] = useState(defaults.tagline);
  // The effect KNOB left the UI (round 7) but the value still threads through
  // preview + save: supersede matches on layout+format+theme+effect, so an old
  // grain design opened here must keep its effect or re-saving would double-card.
  const [effect] = useState(p.initial.initialEffect);
  const [theme, setTheme] = useState<'light' | 'dark'>(p.initial.initialTheme);
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewErr, setPreviewErr] = useState('');
  const [rendering, setRendering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const freeform = Array.isArray(cfg.cells) && cfg.cells.length > 0;
  const debounce = useRef<number>();
  const seq = useRef(0);

  // ---------- the live preview loop ----------
  const renderPreview = async () => {
    const mySeq = ++seq.current;
    setRendering(true);
    try {
      const fmt = formats.find((f) => f.id === formatId);
      const res = await fetch(`/api/projects/${slug}/preview-layout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          config: cfg, title, kicker, tagline, effect: effect || undefined, theme, width: 720,
          formatWidth: fmt?.width, formatHeight: fmt?.height,
          style: scope.style ?? undefined,
          shot: scope.shot ?? undefined,
        }),
      });
      if (mySeq !== seq.current) return; // a newer render superseded this one
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setPreviewErr(d.error ?? `HTTP ${res.status}`);
        return;
      }
      const blob = await res.blob();
      if (mySeq !== seq.current) return;
      setPreviewErr('');
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      });
    } catch (e) {
      if (mySeq === seq.current) setPreviewErr((e as Error).message);
    } finally {
      if (mySeq === seq.current) setRendering(false);
    }
  };
  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => void renderPreview(), 600);
    return () => clearTimeout(debounce.current);
  }, [JSON.stringify(cfg), title, kicker, tagline, effect, theme, formatId]);

  const patch = (up: Partial<Cfg>) => setCfg((c) => ({ ...c, ...up }));
  const patchItem = (list: 'cells' | 'texts' | 'shapes', i: number, up: Record<string, unknown>) =>
    setCfg((c) => ({
      ...c,
      [list]: (c[list] as Record<string, unknown>[]).map((x, j) => (j === i ? { ...x, ...up } : x)),
    }));
  const dropItem = (list: 'cells' | 'texts' | 'shapes', i: number) =>
    setCfg((c) => {
      const next = (c[list] as Record<string, unknown>[]).filter((_, j) => j !== i);
      return { ...c, [list]: next.length ? next : undefined };
    });
  const addItem = (list: 'cells' | 'texts' | 'shapes', item: Record<string, unknown>) =>
    setCfg((c) => ({ ...c, [list]: [...((c[list] as Record<string, unknown>[]) ?? []), item] }));

  const toFreeform = () =>
    patch({
      archetype: undefined,
      cells: [{ x: 0, y: 0, w: 1, h: 1 }],
      lockup: (cfg.lockup as string) ?? 'bottom',
    });
  const toPreset = () =>
    patch({ cells: undefined, texts: undefined, shapes: undefined, archetype: 'hero' });

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const r = (await api.post('/designs', {
        config: cfg,
        name: name || undefined,
        formatId,
        title: title || undefined,
        kicker: kicker || undefined,
        tagline: tagline || undefined,
        theme: theme === 'dark' ? 'dark' : undefined,
        effect: effect || undefined,
        style: scope.style ?? undefined,
        shot: scope.shot ?? undefined,
      })) as { designId: string };
      location.href = `/projects/${slug}/design?lead=${r.designId}`;
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  // ---------- drag-to-move on the preview ----------
  const previewBox = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    list: 'cells' | 'texts' | 'shapes'; i: number;
    startX: number; startY: number; origX: number; origY: number;
  } | null>(null);
  const startDrag = (list: 'cells' | 'texts' | 'shapes', i: number, e: PointerEvent) => {
    const item = (cfg[list] as Record<string, unknown>[] | undefined)?.[i];
    if (!item) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      list, i, startX: e.clientX, startY: e.clientY,
      origX: typeof item.x === 'number' ? item.x : 0,
      origY: typeof item.y === 'number' ? item.y : 0,
    };
  };
  const moveDrag = (e: PointerEvent) => {
    const d = drag.current;
    const box = previewBox.current?.getBoundingClientRect();
    if (!d || !box || box.width === 0) return;
    const round = (n: number) => Math.round(n * 200) / 200; // 0.005 steps
    const item = (cfg[d.list] as Record<string, unknown>[])[d.i]!;
    const w = typeof item.w === 'number' ? item.w : 1;
    const x = Math.max(0, Math.min(1 - Math.min(w, 1), d.origX + (e.clientX - d.startX) / box.width));
    const y = Math.max(0, Math.min(0.98, d.origY + (e.clientY - d.startY) / box.height));
    patchItem(d.list, d.i, { x: round(x), y: round(y) });
  };
  const endDrag = () => { drag.current = null; };

  const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : d);
  const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);

  const numField = (label: string, value: number, on: (n: number) => void, step = 0.05, min = 0, max = 1) => (
    <label class="le-num">
      <span>{label}</span>
      <input type="number" value={value} step={step} min={min} max={max}
        onInput={(e) => on(Number((e.target as HTMLInputElement).value))} />
    </label>
  );

  return (
    <div class="le">
      <div class="le-controls">
        {error && <p class="flash">{error}</p>}

        <label class="field"><span>Start from a saved layout</span>
          <select value="" onChange={(e) => {
            const l = layouts.find((x) => x.id === (e.target as HTMLSelectElement).value);
            if (l) { setCfg(JSON.parse(l.config) as Cfg); setName(`${l.name} (edited)`); }
          }}>
            <option value="">— keep editing this one —</option>
            {layouts.map((l) => <option value={l.id}>{l.name}</option>)}
          </select>
        </label>

        <div class="le-mode">
          <button type="button" class={`btn small ${!freeform ? '' : 'ghost'}`} onClick={toPreset}>Preset</button>
          <button type="button" class={`btn small ${freeform ? '' : 'ghost'}`} onClick={toFreeform}>Freeform</button>
        </div>

        {!freeform ? (
          <div class="le-group">
            <label class="field"><span>Archetype</span>
              <select value={str(cfg.archetype, 'hero')} onChange={(e) => patch({ archetype: (e.target as HTMLSelectElement).value })}>
                {ARCHETYPES.map((a) => <option value={a}>{a}</option>)}
              </select>
            </label>
            <div class="le-row">
              {numField('split', num(cfg.split, 0.58), (n) => patch({ split: n }), 0.02, 0.2, 0.8)}
              <label class="le-num"><span>seam</span>
                <select value={str(cfg.seam, 'feather')} onChange={(e) => patch({ seam: (e.target as HTMLSelectElement).value })}>
                  {SEAMS.map((s) => <option value={s}>{s}</option>)}
                </select>
              </label>
              <label class="le-num"><span>labels</span>
                <input type="checkbox" checked={cfg.labels !== false} onChange={(e) => patch({ labels: (e.target as HTMLInputElement).checked })} />
              </label>
            </div>
          </div>
        ) : (
          <div class="le-group">
            <p class="ws-mini">Cells — fractions of the image area ({pickCount} pick{pickCount === 1 ? '' : 's'} available)</p>
            {(cfg.cells ?? []).map((c, i) => (
              <div class="le-item">
                <b class="mono">cell {i + 1}</b>
                <div class="le-row">
                  {numField('x', num(c.x), (n) => patchItem('cells', i, { x: n }))}
                  {numField('y', num(c.y), (n) => patchItem('cells', i, { y: n }))}
                  {numField('w', num(c.w, 1), (n) => patchItem('cells', i, { w: n }))}
                  {numField('h', num(c.h, 1), (n) => patchItem('cells', i, { h: n }))}
                  <label class="le-num"><span>fit</span>
                    <select value={str(c.fit, 'cover')} onChange={(e) => patchItem('cells', i, { fit: (e.target as HTMLSelectElement).value })}>
                      <option value="cover">cover</option><option value="contain">contain</option>
                    </select>
                  </label>
                  {numField('z', num(c.z), (n) => patchItem('cells', i, { z: n }), 1, 0, 30)}
                </div>
                <div class="le-row le-edges">
                  <span>feather:</span>
                  {EDGES.map((e2) => (
                    <label class="le-num inline">
                      <input type="checkbox"
                        checked={Array.isArray(c.feather) && (c.feather as string[]).includes(e2)}
                        onChange={(ev) => {
                          const cur = new Set(Array.isArray(c.feather) ? (c.feather as string[]) : []);
                          (ev.target as HTMLInputElement).checked ? cur.add(e2) : cur.delete(e2);
                          patchItem('cells', i, { feather: cur.size ? [...cur] : undefined });
                        }} />
                      <span>{e2}</span>
                    </label>
                  ))}
                  <button type="button" class="linkish le-del" onClick={() => dropItem('cells', i)}>✕ remove</button>
                </div>
              </div>
            ))}
            {(cfg.cells?.length ?? 0) < Math.min(8, pickCount) && (
              <button type="button" class="btn small ghost" onClick={() => addItem('cells', { x: 0.5, y: 0, w: 0.5, h: 1 })}>
                <I name="add" />Add cell
              </button>
            )}

            <p class="ws-mini">Text layers</p>
            {(cfg.texts ?? []).map((t, i) => (
              <div class="le-item">
                <div class="le-row">
                  <label class="le-num wide"><span>content ("@title" binds the project title)</span>
                    <input type="text" value={
                      typeof t.content === 'object' && t.content
                        ? `@${str((t.content as Record<string, unknown>).role).replace('project', '').toLowerCase()}`
                        : str(t.content)
                    } onInput={(e) => {
                      const v = (e.target as HTMLInputElement).value;
                      const m = v.match(/^@(title|kicker|tagline)$/i);
                      patchItem('texts', i, {
                        content: m ? { role: `project${m[1]![0]!.toUpperCase()}${m[1]!.slice(1).toLowerCase()}` } : v,
                      });
                    }} />
                  </label>
                  <label class="le-num"><span>font</span>
                    <select value={str(t.font, 'title')} onChange={(e) => patchItem('texts', i, { font: (e.target as HTMLSelectElement).value })}>
                      {FONTS.map((f) => <option value={f}>{f}</option>)}
                    </select>
                  </label>
                </div>
                <div class="le-row">
                  {numField('x', num(t.x), (n) => patchItem('texts', i, { x: n }))}
                  {numField('y', num(t.y), (n) => patchItem('texts', i, { y: n }))}
                  {numField('w', num(t.w, 0.9), (n) => patchItem('texts', i, { w: n }))}
                  {numField('scale', num(t.sizeScale, 1), (n) => patchItem('texts', i, { sizeScale: n }), 0.1, 0.3, 4)}
                  <label class="le-num"><span>color</span>
                    <select value={str(t.color, 'ink')} onChange={(e) => patchItem('texts', i, { color: (e.target as HTMLSelectElement).value })}>
                      {TOKENS.map((k) => <option value={k}>{k}</option>)}
                    </select>
                  </label>
                  <label class="le-num"><span>underline</span>
                    <select value={str(t.underline, '')} onChange={(e) => {
                      const v = (e.target as HTMLSelectElement).value;
                      patchItem('texts', i, { underline: v || undefined });
                    }}>
                      <option value="">none</option>
                      <option value="accent">accent (kit red)</option>
                      <option value="single">single</option>
                      <option value="low">low</option>
                    </select>
                  </label>
                  <label class="le-num"><span>highlight</span>
                    <select value={str(t.highlight, '')} onChange={(e) => {
                      const v = (e.target as HTMLSelectElement).value;
                      patchItem('texts', i, { highlight: v || undefined, highlightAlpha: v ? num(t.highlightAlpha, 1) : undefined });
                    }}>
                      <option value="">none</option>
                      {TOKENS.map((k) => <option value={k}>{k}</option>)}
                    </select>
                  </label>
                  <label class="le-num inline">
                    <input type="checkbox" checked={!!t.strike}
                      onChange={(ev) => patchItem('texts', i, { strike: (ev.target as HTMLInputElement).checked || undefined })} />
                    <span>strike</span>
                  </label>
                  {(cfg.shapes?.length ?? 0) < 8 && (
                    <button type="button" class="linkish"
                      title="add a short accent rule under this text — drag it after"
                      onClick={() =>
                        addItem('shapes', {
                          kind: 'rule',
                          x: num(t.x),
                          y: Math.min(0.98, num(t.y) + 0.11 * num(t.sizeScale, 1)),
                          w: Math.min(num(t.w, 0.9), 0.22),
                          h: 0.012,
                          color: 'redDeep',
                          opacity: 1,
                        })}>
                      + accent line
                    </button>
                  )}
                  <button type="button" class="linkish le-del" onClick={() => dropItem('texts', i)}>✕</button>
                </div>
              </div>
            ))}
            {(cfg.texts?.length ?? 0) < 6 && (
              <button type="button" class="btn small ghost"
                onClick={() => addItem('texts', { content: { role: 'projectTitle' }, font: 'title', x: 0.06, y: 0.1, w: 0.7, color: 'ink' })}>
                <I name="add" />Add text
              </button>
            )}

            <p class="ws-mini">Shapes</p>
            {(cfg.shapes ?? []).map((s, i) => (
              <div class="le-item">
                <div class="le-row">
                  <label class="le-num"><span>kind</span>
                    <select value={str(s.kind, 'rect')} onChange={(e) => patchItem('shapes', i, { kind: (e.target as HTMLSelectElement).value })}>
                      <option value="rect">rect</option><option value="rule">rule</option><option value="gradient">gradient</option>
                    </select>
                  </label>
                  {numField('x', num(s.x), (n) => patchItem('shapes', i, { x: n }))}
                  {numField('y', num(s.y), (n) => patchItem('shapes', i, { y: n }))}
                  {numField('w', num(s.w, 1), (n) => patchItem('shapes', i, { w: n }))}
                  {numField('h', num(s.h, 0.1), (n) => patchItem('shapes', i, { h: n }))}
                  <label class="le-num"><span>color</span>
                    <select value={str(s.color, 'red')} onChange={(e) => patchItem('shapes', i, { color: (e.target as HTMLSelectElement).value })}>
                      {TOKENS.map((k) => <option value={k}>{k}</option>)}
                    </select>
                  </label>
                  {numField('opacity', num(s.opacity, 1), (n) => patchItem('shapes', i, { opacity: n }), 0.05)}
                  <button type="button" class="linkish le-del" onClick={() => dropItem('shapes', i)}>✕</button>
                </div>
              </div>
            ))}
            {(cfg.shapes?.length ?? 0) < 8 && (
              <button type="button" class="btn small ghost"
                onClick={() => addItem('shapes', { kind: 'rect', x: 0, y: 0.85, w: 1, h: 0.15, color: 'red', opacity: 0.9 })}>
                <I name="add" />Add shape
              </button>
            )}

            <div class="le-row">
              <label class="le-num"><span>background</span>
                <select value={str(cfg.background, 'line')} onChange={(e) => patch({ background: (e.target as HTMLSelectElement).value })}>
                  {TOKENS.map((k) => <option value={k}>{k}</option>)}
                </select>
              </label>
            </div>
          </div>
        )}

        <div class="le-group">
          <div class="le-row">
            <label class="le-num"><span>lockup</span>
              <select value={str(cfg.lockup, 'bottom')} onChange={(e) => patch({ lockup: (e.target as HTMLSelectElement).value })}>
                {LOCKUPS.map((l) => <option value={l}>{l}</option>)}
              </select>
            </label>
            <label class="le-num"><span>theme</span>
              <select value={theme} onChange={(e) => setTheme((e.target as HTMLSelectElement).value as 'light' | 'dark')}>
                <option value="light">light</option>
                <option value="dark">dark{kitHasDark ? '' : ' (kit has no dark palette)'}</option>
              </select>
            </label>
          </div>
          <div class="le-row">
            <label class="le-num wide"><span>title</span>
              <input type="text" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} /></label>
            <label class="le-num wide"><span>kicker</span>
              <input type="text" value={kicker} onInput={(e) => setKicker((e.target as HTMLInputElement).value)} /></label>
            <label class="le-num wide"><span>tagline</span>
              <input type="text" value={tagline} onInput={(e) => setTagline((e.target as HTMLInputElement).value)} /></label>
          </div>
        </div>

        <div class="le-group le-save">
          <label class="le-num wide"><span>save as</span>
            <input type="text" value={name} placeholder="template name" onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
          <label class="le-num"><span>format</span>
            <select value={formatId} onChange={(e) => setFormatId((e.target as HTMLSelectElement).value)}>
              {formats.map((f) => <option value={f.id}>{f.name} · {f.width}×{f.height}</option>)}
            </select>
          </label>
          <button class={`btn ${saving ? 'running' : ''}`} disabled={saving} onClick={save}>
            {saving ? 'Rendering…' : <><I name="save" />Save & render · $0.00</>}
          </button>
        </div>
      </div>

      <div class="le-preview">
        <p class="ws-mini">
          Live preview — your real picks, re-rendered on every change
          {freeform ? ' · drag any box to move it' : ''}{rendering ? ' · rendering…' : ''}
        </p>
        {previewErr && <p class="flash">{previewErr}</p>}
        {previewUrl ? (
          <div class="le-stage" ref={previewBox} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
            <img src={previewUrl} alt="layout preview" draggable={false} />
            {freeform &&
              (['cells', 'texts', 'shapes'] as const).map((list) =>
                ((cfg[list] as Record<string, unknown>[] | undefined) ?? []).map((it, i) => (
                  <div
                    class={`le-handle le-h-${list}`}
                    style={{
                      left: `${num(it.x) * 100}%`,
                      top: `${num(it.y) * 100}%`,
                      width: `${Math.max(num(it.w, list === 'texts' ? 0.9 : 1), 0.06) * 100}%`,
                      height: list === 'cells' ? `${Math.max(num(it.h, 1), 0.06) * 100}%`
                        : list === 'shapes' ? `${Math.max(num(it.h, 0.1), 0.04) * 100}%` : undefined,
                    }}
                    onPointerDown={(e) => startDrag(list, i, e as unknown as PointerEvent)}
                    title={`drag to move ${list.slice(0, -1)} ${i + 1}`}
                  >
                    <span>{list === 'texts' ? `text ${i + 1}` : list === 'cells' ? `image ${i + 1}` : `shape ${i + 1}`}</span>
                  </div>
                )),
              )}
          </div>
        ) : !previewErr ? (
          <p class="sub">rendering the first preview…</p>
        ) : null}
      </div>
    </div>
  );
}
