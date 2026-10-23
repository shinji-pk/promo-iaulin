// Emet is the sole identity authority for /promo/?organizationId=...
// Never trust user IDs, roles, or organization claims sent by the browser.
export const EMET_ORIGIN = 'https://emet.shinjiapps.com';
export const EMET_ACCESS_COOKIE = '__Host-emet-access';
export const ORGANIZATION_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export interface EmetPrincipal {
  user: { id: string; email: string; name: string };
  organization: { id: string; name: string; role: 'owner' | 'admin' | 'manager' | 'office' | 'crew' };
}

export class EmetAccessError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}

export function hasEmetCookie(header: string): boolean {
  return header.split(';').some(part => part.trim().startsWith(EMET_ACCESS_COOKIE + '='));
}

function extractAccessCookie(header: string): string {
  const parts = header.split(';').map(part => part.trim()).filter(part => part.startsWith(EMET_ACCESS_COOKIE + '='));
  if (parts.length !== 1) throw new EmetAccessError(401, 'AUTH_REQUIRED');
  let token: string;
  try { token = decodeURIComponent(parts[0].slice(EMET_ACCESS_COOKIE.length + 1)); }
  catch { throw new EmetAccessError(401, 'AUTH_REQUIRED'); }
  if (!/^[A-Za-z0-9._~-]{20,4096}$/.test(token)) throw new EmetAccessError(401, 'AUTH_REQUIRED');
  return token;
}

export async function verifyEmetAccess(
  input: { organizationId: string; cookie: string },
  fetcher: typeof fetch = fetch,
): Promise<EmetPrincipal> {
  if (!ORGANIZATION_ID_PATTERN.test(input.organizationId)) throw new EmetAccessError(400, 'INVALID_ORGANIZATION');
  const accessToken = extractAccessCookie(input.cookie);
  const url = new URL('/api/emet/module-access', EMET_ORIGIN);
  url.searchParams.set('organizationId', input.organizationId);
  url.searchParams.set('module', 'promo');
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { Cookie: EMET_ACCESS_COOKIE + '=' + accessToken, Accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
  } catch { throw new EmetAccessError(503, 'EMET_UNAVAILABLE'); }
  if (response.status === 401) throw new EmetAccessError(401, 'AUTH_REQUIRED');
  if (response.status === 403 || response.status === 409) throw new EmetAccessError(403, 'EMET_ACCESS_DENIED');
  if (response.status === 429) throw new EmetAccessError(429, 'EMET_RATE_LIMITED');
  if (!response.ok) throw new EmetAccessError(503, 'EMET_UNAVAILABLE');
  let body: unknown;
  try { body = await response.json(); } catch { throw new EmetAccessError(503, 'EMET_INVALID_RESPONSE'); }
  if (!body || typeof body !== 'object') throw new EmetAccessError(503, 'EMET_INVALID_RESPONSE');
  const data = body as Record<string, unknown>;
  const user = data.user as Record<string, unknown> | undefined;
  const org = data.organization as Record<string, unknown> | undefined;
  const roles = ['owner', 'admin', 'manager', 'office', 'crew'];
  if (data.module !== 'promo' || !user || !org || !ORGANIZATION_ID_PATTERN.test(String(user.id || '')) ||
      typeof user.email !== 'string' || !user.email.includes('@') ||
      org.id !== input.organizationId || typeof org.name !== 'string' || !roles.includes(String(org.role))) {
    throw new EmetAccessError(503, 'EMET_INVALID_RESPONSE');
  }
  return {
    user: { id: String(user.id), email: user.email, name: String(user.displayName || user.email) },
    organization: { id: input.organizationId, name: org.name, role: org.role as EmetPrincipal['organization']['role'] },
  };
}
