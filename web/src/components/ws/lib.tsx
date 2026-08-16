/**
 * Shared pieces of the workspace islands (Overview + ShotEditor). The round-3
 * invariants live here so both islands keep them: hold-to-confirm timings, the
 * JPEG upload recipe, the save-state vocabulary, one icon set.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { ICON_PATHS, type IconName } from '../icons';

export const LIVE = ['queued', 'running', 'rendering'];
export const CHAIN = /\{\s*shot\s+(\d+)\s*\}/gi;
export const usd = (m: number) => `$${(m / 1_000_000).toFixed(m >= 100_000 ? 2 : 4)}`;

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'empty';

export const BADGE: Record<SaveState, [string, string]> = {
  saved: ['ws-badge saved', 'Saved ✓'],
  dirty: ['ws-badge dirty', 'Unsaved…'],
  saving: ['ws-badge saving', 'Saving…'],
  error: ['ws-badge err', 'Save failed — retrying'],
  empty: ['ws-badge err', 'Empty prompt — not saved'],
};

export interface ModelRef {
  alias: string;
  refStyle: 'array' | 'single' | 'none';
  maxRefs: number;
}

/** Same icon set as Icon.astro — one source, two renderers. */
export const I = ({ name }: { name: IconName }) => (
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

/** JSON fetch helpers scoped to one project's API. */
export function makeApi(slug: string) {
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
  return { call, post };
}

/** Client-side JPEG conversion, same recipe as the global data-jpeg handler. */
export async function toJpeg(file: File): Promise<File> {
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
export function HoldButton(props: {
  label: ComponentChildren;
  confirm: string;
  onFire: () => void;
  cls?: string;
}) {
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

/**
 * Modal on native <dialog>: Esc and backdrop-click close it. Previews and
 * pickers only — destructive actions keep hold-to-confirm, never a dialog.
 */
export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title?: string;
  wide?: boolean;
  children: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  if (!props.open) return null;
  return (
    <dialog
      ref={ref}
      class={`ws-modal ${props.wide ? 'wide' : ''}`}
      onClose={props.onClose}
      onClick={(e) => {
        if (e.target === ref.current) props.onClose(); // backdrop click
      }}
    >
      <div class="ws-modal-body">
        <header class="ws-modal-head">
          {props.title && <b>{props.title}</b>}
          <button type="button" class="linkish ws-modal-x" onClick={props.onClose}>✕ close</button>
        </header>
        {props.children}
      </div>
    </dialog>
  );
}
