export const API_BASE = '/api';

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** Best-effort `{ error }` body message, falling back to the status code. */
export async function bodyError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // non-JSON error body — fall back to the status code
  }
  return `HTTP ${res.status}`;
}

export async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(await bodyError(res));
  return (await res.json()) as T;
}

/** fetch() that throws on non-ok and returns the raw (ok) Response. */
export async function httpStatus(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(await bodyError(res));
  return res;
}

export function jsonRequest<T>(body: T): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}