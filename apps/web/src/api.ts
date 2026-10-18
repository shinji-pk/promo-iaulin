import type { AppSnapshot } from '../../../packages/shared/src/index.ts';
import { demoRequest } from './demo.ts';

let csrf = '';
let demonstration = false;
const remote = !['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname);

export function isDemonstration() { return demonstration; }

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (demonstration) return demoRequest(path, method, body) as Promise<T>;
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
  } catch { throw new Error('Não conseguimos acessar o aplicativo local. Confira se o PromoBridge está aberto no computador e tente novamente.'); }
  let data: any;
  try { data = await response.json(); } catch { throw new Error('O aplicativo local não respondeu. Confira se o PromoBridge está aberto no computador.'); }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.message || 'Não foi possível concluir esta ação.');
  return data as T;
}

export async function initialize(): Promise<AppSnapshot> {
  try {
    const session = await request<{ csrfToken: string }>('/session');
    csrf = session.csrfToken;
    return await request<AppSnapshot>('/state');
  } catch (error) {
    if (!remote) throw error;
    demonstration = true;
    return await demoRequest('/state', 'GET') as AppSnapshot;
  }
}

export const api = {
  state: () => request<AppSnapshot>('/state'),
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) => request<T>(path, 'POST', body),
  put: <T,>(path: string, body: unknown) => request<T>(path, 'PUT', body),
};
