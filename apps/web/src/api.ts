import type { AppSnapshot } from '../../../packages/shared/src/index.ts';
import { demoRequest } from './demo.ts';

let csrf = '';
let demonstration = false;
const remote = !['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname);
class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

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
  try { data = await response.json(); } catch { throw new ApiError('O aplicativo local não respondeu. Confira se o PromoBridge está aberto no computador.', response.status === 404 ? 404 : 502); }
  if (response.status === 401 && data.code === 'AUTH_REQUIRED') window.dispatchEvent(new Event('promobridge:session-expired'));
  if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : data.message || 'Não foi possível concluir esta ação.', response.status);
  return data as T;
}

export async function initialize(): Promise<AppSnapshot> {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const pair = fragment.get('pair');
  if (pair) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#today`);
    const session = await request<{ csrfToken: string }>('/remote/pair', 'POST', { code: pair });
    csrf = session.csrfToken;
  }
  try {
    const session = await request<{ csrfToken: string }>('/session');
    csrf = session.csrfToken;
    return await request<AppSnapshot>('/state');
  } catch (error) {
    if (!remote) throw error;
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw new Error('Este acesso precisa de um pareamento válido. No PromoBridge do computador, abra Fontes & conexões → Acessar pelo celular e use o novo QR Code.', { cause: error });
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    demonstration = true;
    return await demoRequest('/state', 'GET') as AppSnapshot;
  }
}

export const api = {
  state: () => request<AppSnapshot>('/state'),
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) => request<T>(path, 'POST', body),
  put: <T,>(path: string, body: unknown) => request<T>(path, 'PUT', body),
  delete: <T,>(path: string) => request<T>(path, 'DELETE'),
};
