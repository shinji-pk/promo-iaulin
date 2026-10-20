/** The WhatsApp service hosted on an always-on server, shared with the people who own this installation. */
export interface ManagedWorker { origin: string; token: string; owners: ReadonlySet<string>; }

/** Same hostname rules as a pairing link, but without the one-time code. */
export function parseWorkerOrigin(input: string): string {
  if (typeof input !== 'string' || input.length > 2048 || /[\s\\]/u.test(input)) throw new Error('Endereço do servidor inválido.');
  const url = new URL(input), hostname = url.hostname;
  if (url.protocol !== 'https:' || url.username || url.password || url.port || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash
    || hostname.endsWith('.') || !hostname.includes('.') || !/^[a-z0-9.-]+$/i.test(hostname)
    || hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    || ['localhost', 'local', 'internal', 'test', 'invalid', 'example', 'onion'].some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`)))
    throw new Error('O servidor precisa de um endereço público HTTPS válido, sem porta.');
  return url.origin;
}

/**
 * Reads MANAGED_WORKER_URL, MANAGED_WORKER_TOKEN and MANAGED_WORKER_OWNERS.
 * Anything missing or malformed disables the feature: it never falls back to "everyone".
 */
export function managedWorkerFromEnv(env: NodeJS.ProcessEnv = process.env): ManagedWorker | null {
  const url = env.MANAGED_WORKER_URL?.trim(), token = env.MANAGED_WORKER_TOKEN?.trim();
  const owners = new Set((env.MANAGED_WORKER_OWNERS ?? '').split(/[,;\s]+/).map(item => item.trim().toLowerCase()).filter(item => item.includes('@')));
  if (!url || !token || token.length < 32 || !owners.size) return null;
  try { return { origin: parseWorkerOrigin(url), token, owners }; } catch { return null; }
}

export function isManagedOwner(managed: ManagedWorker | null, email: string | null | undefined): managed is ManagedWorker {
  return Boolean(managed && email && managed.owners.has(email.trim().toLowerCase()));
}
