export type User = { id: number; username: string; color: string; wins: number; losses: number; saveAt?: number | null };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = typeof body.detail === 'string' ? body.detail : message;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, message || `Lỗi ${res.status}`);
  }
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? res.json() : res.arrayBuffer()) as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  config: () => request<{ inviteRequired: boolean; romAvailable: boolean }>('/api/config'),
  me: () => request<User>('/api/me'),
  login: (username: string, password: string) => request<User>('/api/auth/login', json({ username, password })),
  register: (username: string, password: string, invite?: string) =>
    request<User>('/api/auth/register', json({ username, password, invite })),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  rom: (version = '') => request<ArrayBuffer>(version ? `/api/rom?v=${encodeURIComponent(version)}` : '/api/rom'),
  async getSave(): Promise<{ data: Uint8Array; savedAt: number } | null> {
    const res = await fetch('/api/save', { credentials: 'same-origin' });
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(res.status, `Không tải được save (${res.status})`);
    return { data: new Uint8Array(await res.arrayBuffer()), savedAt: Number(res.headers.get('X-Saved-At')) || 0 };
  },
  putSave: (data: Uint8Array) =>
    request<{ savedAt: number }>('/api/save', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data as BodyInit,
    }),
  leaderboard: () => request<{ id: number; username: string; color: string; wins: number; losses: number }[]>('/api/leaderboard'),
};
