export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type Listener = () => void;
let onUnauthorized: Listener = () => {};
export function setUnauthorizedHandler(fn: Listener): void {
  onUnauthorized = fn;
}

export function notifyUnauthorized(): void {
  onUnauthorized();
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', signal });
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'Not signed in');
  }
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status} for ${path}`);
  return (await res.json()) as T;
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'Not signed in');
  }
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status} for ${path}`);
  return (await res.json().catch(() => ({}))) as T;
}
