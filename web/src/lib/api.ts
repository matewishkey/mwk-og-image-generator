/** Micro-helpers for the /api/* JSON routes. */

const HEADERS = { 'cache-control': 'no-store' };

export const ok = (data: unknown, status = 200): Response =>
  Response.json(data, { status, headers: HEADERS });

export const err = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers: HEADERS });

/**
 * Parse a JSON request body. Returns null unless the content type is
 * application/json — which doubles as the CSRF guard: an HTML form cannot
 * send that content type cross-origin without a preflight.
 */
export async function readJson<T = Record<string, unknown>>(request: Request): Promise<T | null> {
  const ct = request.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) return null;
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
