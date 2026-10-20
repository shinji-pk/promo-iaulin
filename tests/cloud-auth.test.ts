import { describe, expect, it, vi } from 'vitest';
import { createCloudAuth, getEmailSender, hasEmailProvider } from '../apps/cloud/src/auth.ts';
import { emptyAuthDocument, type AuthDocument } from '../apps/cloud/src/blob-auth-adapter.ts';
import { JsonDocumentStore, StoreConflictError, type JsonBackend } from '../apps/cloud/src/blob-store.ts';

const baseURL = 'https://promo.test';
const secret = 'promobridge-auth-test-secret-at-least-thirty-two-characters';
const password = 'Uma senha longa para os testes 123!';

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Behaves like private Blob: every read sees serialized data; writes use CAS. */
class MemoryBackend implements JsonBackend {
  private documents = new Map<string, { etag: string; value: unknown }>();
  private revision = 0;
  failWrites = false;
  failAuthCommits = false;

  async read(pathname: string) {
    const document = this.documents.get(pathname);
    return document ? jsonClone(document) : null;
  }

  async write(pathname: string, value: unknown, expectedEtag: string | null) {
    if (this.failWrites || (this.failAuthCommits && (value as AuthDocument).tables.user?.length)) {
      throw new Error('Test storage is unavailable.');
    }
    const document = this.documents.get(pathname);
    if ((document?.etag ?? null) !== expectedEtag) throw new StoreConflictError();
    this.documents.set(pathname, { etag: `revision-${++this.revision}`, value: jsonClone(value) });
  }
}

function setup() {
  const backend = new MemoryBackend();
  const newStore = () => new JsonDocumentStore<AuthDocument>({
    backend,
    pathname: 'private/test-auth.json',
    initial: emptyAuthDocument,
    maxAttempts: 30,
  });
  const freshAuth = () => createCloudAuth({ store: newStore(), baseURL, secret });
  return { freshAuth, newStore, backend };
}

type Auth = ReturnType<typeof createCloudAuth>;

function request(auth: Auth, path: string, options: { body?: unknown; cookie?: string; origin?: string } = {}) {
  return auth.handler(new Request(`${baseURL}/api/auth/${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: options.origin ?? baseURL,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }));
}

function sessionCookie(response: { headers: Headers }) {
  const cookies = response.headers.getSetCookie();
  expect(cookies.some(cookie => /session_token=/.test(cookie))).toBe(true);
  return cookies.map(cookie => cookie.split(';')[0]).join('; ');
}

const registration = (email = 'pessoa@example.com') => ({ email, password, name: 'Pessoa de teste' });

describe('domain-independent email recovery preparation', () => {
  it('does not promise password recovery before a sending domain is configured', () => {
    try {
      vi.stubEnv('RESEND_API_KEY', 'mock-resend-key-never-used');
      vi.stubEnv('RESEND_FROM_EMAIL', '');
      vi.stubEnv('TRANSACTIONAL_EMAIL_DOMAIN', '');
      expect(getEmailSender()).toBeNull();
      expect(hasEmailProvider()).toBe(false);
      vi.stubEnv('TRANSACTIONAL_EMAIL_DOMAIN', 'shinjiapps.com');
      expect(getEmailSender()).toBe('Promo IAulin <promo@shinjiapps.com>');
      expect(hasEmailProvider()).toBe(true);
      vi.stubEnv('TRANSACTIONAL_EMAIL_DOMAIN', 'iaulinbot.vercel.app');
      expect(hasEmailProvider()).toBe(false);
      vi.stubEnv('RESEND_FROM_EMAIL', 'Outro Nome <contas@shinjiapps.com>');
      expect(getEmailSender()).toBe('Outro Nome <contas@shinjiapps.com>');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('cloud authentication through actual Better Auth HTTP handlers and persistent CAS documents', () => {
  it('registers a user and restores its session in a fresh server instance', async () => {
    const { freshAuth, newStore } = setup();
    const signedUp = await request(freshAuth(), 'sign-up/email', { body: registration() });
    expect(signedUp.status).toBe(200);
    const cookie = sessionCookie(signedUp);
    const body = await signedUp.json() as { user: { id: string; email: string; name: string } };
    expect(body.user).toMatchObject({ email: 'pessoa@example.com', name: 'Pessoa de teste' });
    expect(body).not.toHaveProperty('password');
    expect(body.user).not.toHaveProperty('password');
    expect(JSON.stringify(body)).not.toContain(password);

    const sessionResponse = await request(freshAuth(), 'get-session', { cookie });
    expect(sessionResponse.status).toBe(200);
    const session = await sessionResponse.json() as { session: { userId: string; expiresAt: string }; user: { id: string } };
    expect(session.user.id).toBe(body.user.id);
    expect(session.session.userId).toBe(body.user.id);
    expect(Date.parse(session.session.expiresAt)).toBeGreaterThan(Date.now());
    expect(session.user).not.toHaveProperty('password');

    const document = await newStore().read();
    expect(JSON.stringify(document)).not.toContain(password);
    expect(JSON.stringify(document)).toContain('pessoa@example.com');
    const tokenCookies = signedUp.headers.getSetCookie().filter(value => /session_token=/.test(value));
    expect(tokenCookies).toHaveLength(1);
    const tokenCookie = tokenCookies[0];
    expect(tokenCookie).toMatch(/(?:^|;\s*)HttpOnly(?:;|$)/i);
    expect(tokenCookie).toMatch(/(?:^|;\s*)Secure(?:;|$)/i);
    expect(tokenCookie).toMatch(/SameSite=Lax/i);
  });

  it('signs in with the stored password hash and signs out across server instances', async () => {
    const { freshAuth } = setup();
    expect((await request(freshAuth(), 'sign-up/email', { body: registration() })).status).toBe(200);
    const signedIn = await request(freshAuth(), 'sign-in/email', {
      body: { email: 'pessoa@example.com', password },
    });
    expect(signedIn.status).toBe(200);
    const cookie = sessionCookie(signedIn);
    expect((await (await request(freshAuth(), 'get-session', { cookie })).json()).user.email).toBe('pessoa@example.com');

    const signedOut = await request(freshAuth(), 'sign-out', { body: {}, cookie });
    expect(signedOut.status).toBe(200);
    const afterSignOut = await request(freshAuth(), 'get-session', { cookie });
    expect(afterSignOut.status).toBe(200);
    expect(await afterSignOut.json()).toBeNull();
  });

  it('rejects wrong passwords, forged cookies, and cross-origin mutations', async () => {
    const { freshAuth } = setup();
    const signedUp = await request(freshAuth(), 'sign-up/email', { body: registration() });
    expect(signedUp.status).toBe(200);
    const wrongPassword = await request(freshAuth(), 'sign-in/email', {
      body: { email: 'pessoa@example.com', password: 'a senha errada 12345' },
    });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.headers.getSetCookie().some(value => /session_token=/.test(value))).toBe(false);

    const forged = sessionCookie(signedUp).replace(/session_token=([^;]+)/, 'session_token=forged-session-token');
    expect(await (await request(freshAuth(), 'get-session', { cookie: forged })).json()).toBeNull();

    const otherOrigin = await request(freshAuth(), 'sign-in/email', {
      body: { email: 'pessoa@example.com', password },
      origin: 'https://outro-site.example',
    });
    expect(otherOrigin.status).toBe(403);
  });

  it('rejects duplicate registration with a normalized email', async () => {
    const { freshAuth } = setup();
    const first = await request(freshAuth(), 'sign-up/email', { body: registration('Pessoa@Example.COM') });
    expect(first.status).toBe(200);
    const duplicate = await request(freshAuth(), 'sign-up/email', { body: registration('pessoa@example.com') });
    expect(duplicate.status).toBeGreaterThanOrEqual(400);
    expect(duplicate.status).toBeLessThan(500);
    const signedIn = await request(freshAuth(), 'sign-in/email', { body: { email: 'PESSOA@example.com', password } });
    expect(signedIn.status).toBe(200);
  });

  it('allows only one account when two instances register the same email concurrently', async () => {
    const { freshAuth, newStore } = setup();
    const responses = await Promise.all([
      request(freshAuth(), 'sign-up/email', { body: registration() }),
      request(freshAuth(), 'sign-up/email', { body: registration() }),
    ]);
    expect(responses.filter(response => response.status === 200)).toHaveLength(1);
    const rejected = responses.find(response => response.status !== 200)!;
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    const document = await newStore().read();
    const users = document.tables.user ?? [];
    expect(users.filter(user => user.email === 'pessoa@example.com')).toHaveLength(1);
    const accounts = document.tables.account ?? [];
    expect(accounts).toHaveLength(1);
    expect((await request(freshAuth(), 'sign-in/email', { body: { email: 'pessoa@example.com', password } })).status).toBe(200);
  });

  it('does not return an account session without a valid authentication cookie', async () => {
    const { freshAuth } = setup();
    expect((await request(freshAuth(), 'sign-up/email', { body: registration() })).status).toBe(200);
    const response = await request(freshAuth(), 'get-session');
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it('does not lose registrations when different users register concurrently', async () => {
    const { freshAuth, newStore } = setup();
    const responses = await Promise.all([
      request(freshAuth(), 'sign-up/email', { body: registration('primeira@example.com') }),
      request(freshAuth(), 'sign-up/email', { body: registration('segunda@example.com') }),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const document = await newStore().read();
    expect(document.tables.user).toHaveLength(2);
    expect(document.tables.account).toHaveLength(2);
    for (const email of ['primeira@example.com', 'segunda@example.com']) {
      expect((await request(freshAuth(), 'sign-in/email', { body: { email, password } })).status).toBe(200);
    }
  });

  it('does not issue a login cookie when persistent storage cannot commit', async () => {
    const { freshAuth, newStore, backend } = setup();
    backend.failWrites = true;
    const response = await request(freshAuth(), 'sign-up/email', { body: registration() });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.getSetCookie().some(value => /session_token=[^;]/.test(value))).toBe(false);
    backend.failWrites = false;
    const document = await newStore().read();
    expect(document.tables.user ?? []).toHaveLength(0);
    expect(document.tables.account ?? []).toHaveLength(0);
    expect((await request(freshAuth(), 'sign-up/email', { body: registration() })).status).toBe(200);
  });

  it('rolls back registration when its user, credential, and session commit fails', async () => {
    const { freshAuth, newStore, backend } = setup();
    // Let the separate rate-limit write succeed, then fail the actual auth transaction.
    backend.failAuthCommits = true;
    const response = await request(freshAuth(), 'sign-up/email', { body: registration() });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.getSetCookie().some(value => /session_token=[^;]/.test(value))).toBe(false);
    backend.failAuthCommits = false;
    const document = await newStore().read();
    expect(document.tables.user ?? []).toHaveLength(0);
    expect(document.tables.account ?? []).toHaveLength(0);
    expect(document.tables.session ?? []).toHaveLength(0);
    expect((await request(freshAuth(), 'sign-up/email', { body: registration() })).status).toBe(200);
  });

  it('rolls back an adapter transaction and consumes one-time credentials exactly once', async () => {
    const { freshAuth } = setup();
    const adapter = (await freshAuth().$context).adapter;
    const verification = { identifier: 'test-once', value: 'a one-time credential', expiresAt: new Date(Date.now() + 60_000) };
    await expect(adapter.transaction(async transaction => {
      await transaction.create({ model: 'verification', data: verification });
      throw new Error('Abort the transaction.');
    })).rejects.toThrow('Abort the transaction.');
    expect(await adapter.findOne({ model: 'verification', where: [{ field: 'identifier', value: verification.identifier }] })).toBeNull();

    await adapter.create({ model: 'verification', data: verification });
    const results = await Promise.all(Array.from({ length: 4 }, async () => {
      const otherAdapter = (await freshAuth().$context).adapter;
      return otherAdapter.consumeOne({ model: 'verification', where: [{ field: 'identifier', value: verification.identifier }] });
    }));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await adapter.findOne({ model: 'verification', where: [{ field: 'identifier', value: verification.identifier }] })).toBeNull();
  });

  it('enforces unique session tokens without damaging an existing session', async () => {
    const { freshAuth, newStore } = setup();
    const signedUp = await request(freshAuth(), 'sign-up/email', { body: registration() });
    expect(signedUp.status).toBe(200);
    const cookie = sessionCookie(signedUp);
    const document = await newStore().read();
    const existing = document.tables.session[0];
    const adapter = (await freshAuth().$context).adapter;
    await expect(adapter.create({ model: 'session', data: {
      userId: existing.userId,
      token: existing.token,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    } })).rejects.toThrow();
    expect((await newStore().read()).tables.session).toHaveLength(1);
    expect((await (await request(freshAuth(), 'get-session', { cookie })).json()).user.email).toBe('pessoa@example.com');
  });

  it('applies guarded counter increments atomically across server instances', async () => {
    const { freshAuth } = setup();
    const adapter = (await freshAuth().$context).adapter;
    const key = 'test-shared-counter';
    await adapter.create({ model: 'rateLimit', data: { key, count: 0, lastRequest: Date.now() } });
    const results = await Promise.all(Array.from({ length: 6 }, async () => {
      const otherAdapter = (await freshAuth().$context).adapter;
      return otherAdapter.incrementOne({
        model: 'rateLimit',
        where: [{ field: 'key', value: key }, { field: 'count', operator: 'lt', value: 3 }],
        increment: { count: 1 },
        set: { lastRequest: Date.now() },
      });
    }));
    expect(results.filter(Boolean)).toHaveLength(3);
    const final = await adapter.findOne<{ count: number }>({ model: 'rateLimit', where: [{ field: 'key', value: key }] });
    expect(final?.count).toBe(3);
  });

  it('honors selected fields when reading multiple account records', async () => {
    const { freshAuth } = setup();
    expect((await request(freshAuth(), 'sign-up/email', { body: registration() })).status).toBe(200);
    const adapter = (await freshAuth().$context).adapter;
    const accounts = await adapter.findMany<Record<string, unknown>>({ model: 'account', select: ['id', 'providerId'] });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toEqual({ id: expect.any(String), providerId: 'credential' });
    // Better Auth reconstructs schema keys with undefined values after projection.
    expect(accounts[0].password).toBeUndefined();
  });

  it('cascades user deletion to its credentials and sessions', async () => {
    const { freshAuth, newStore } = setup();
    const signedUp = await request(freshAuth(), 'sign-up/email', { body: registration() });
    expect(signedUp.status).toBe(200);
    const cookie = sessionCookie(signedUp);
    const user = (await signedUp.json() as { user: { id: string } }).user;
    const adapter = (await freshAuth().$context).adapter;
    await adapter.delete({ model: 'user', where: [{ field: 'id', value: user.id }] });
    const document = await newStore().read();
    expect(document.tables.user).toHaveLength(0);
    expect(document.tables.account).toHaveLength(0);
    expect(document.tables.session).toHaveLength(0);
    expect(await (await request(freshAuth(), 'get-session', { cookie })).json()).toBeNull();
  });

  it('rejects account records referencing a user that does not exist', async () => {
    const { freshAuth, newStore } = setup();
    const adapter = (await freshAuth().$context).adapter;
    await expect(adapter.create({ model: 'account', data: {
      userId: 'a-user-that-does-not-exist', providerId: 'credential', accountId: 'an-orphan-account', password: 'test hash',
    } })).rejects.toThrow();
    expect((await newStore().read()).tables.account ?? []).toHaveLength(0);
  });

  it('keeps a failed bulk update atomic when its error is caught inside a transaction', async () => {
    const { freshAuth } = setup();
    for (const email of ['primeira@example.com', 'segunda@example.com']) {
      expect((await request(freshAuth(), 'sign-up/email', { body: registration(email) })).status).toBe(200);
    }
    const adapter = (await freshAuth().$context).adapter;
    await adapter.transaction(async transaction => {
      await expect(transaction.updateMany({ model: 'user', where: [], update: { email: 'duplicada@example.com' } })).rejects.toThrow();
      const users = await transaction.findMany<{ email: string }>({ model: 'user', select: ['email'], sortBy: { field: 'email', direction: 'asc' } });
      expect(users.map(user => user.email)).toEqual(['primeira@example.com', 'segunda@example.com']);
    });
    const users = await adapter.findMany<{ email: string }>({ model: 'user', select: ['email'], sortBy: { field: 'email', direction: 'asc' } });
    expect(users.map(user => user.email)).toEqual(['primeira@example.com', 'segunda@example.com']);
  });

  it('blocks cookie-authenticated mutations with a missing Origin', async () => {
    const { freshAuth } = setup();
    const signedUp = await request(freshAuth(), 'sign-up/email', { body: registration() });
    expect(signedUp.status).toBe(200);
    const cookie = sessionCookie(signedUp);
    const response = await freshAuth().handler(new Request(`${baseURL}/api/auth/sign-out`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
    }));
    expect(response.status).toBe(403);
    expect((await (await request(freshAuth(), 'get-session', { cookie })).json()).user.email).toBe('pessoa@example.com');
  });

  it('changes the password, revokes old sessions, and returns a usable replacement cookie', async () => {
    const { freshAuth } = setup();
    const signedUp = await request(freshAuth(), 'sign-up/email', { body: registration() });
    expect(signedUp.status).toBe(200);
    const oldCookie = sessionCookie(signedUp);
    const newPassword = 'Outra senha longa, privada e exclusiva 456!';
    const changed = await freshAuth().api.changePassword({
      headers: new Headers({ Cookie: oldCookie, Origin: baseURL }),
      body: { currentPassword: password, newPassword, revokeOtherSessions: true },
      returnHeaders: true,
    });
    const newCookie = sessionCookie(changed);
    expect(newCookie).not.toBe(oldCookie);
    expect(await (await request(freshAuth(), 'get-session', { cookie: oldCookie })).json()).toBeNull();
    expect((await (await request(freshAuth(), 'get-session', { cookie: newCookie })).json()).user.email).toBe('pessoa@example.com');
    expect((await request(freshAuth(), 'sign-in/email', { body: { email: 'pessoa@example.com', password } })).status).toBe(401);
    expect((await request(freshAuth(), 'sign-in/email', { body: { email: 'pessoa@example.com', password: newPassword } })).status).toBe(200);
  });
});
