import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signToken } from '../src/services/auth.js';
import { auth, createHarness, seedUser, TEST_PASSWORD, type TestHarness } from './helpers.js';

let h: TestHarness;

async function boot(): Promise<TestHarness> {
  h = await createHarness();
  return h;
}

describe('POST /api/auth/register', () => {
  it('is removed — there is no public registration', async () => {
    const { app, store } = await boot();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'Ada@example.com', name: 'Ada Lovelace', password: 'analytical1' })
      .expect(404);

    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(await store.findUserByEmail('ada@example.com')).toBeNull();
  });
});

describe('POST /api/auth/login', () => {
  it('authenticates the admin with correct credentials', async () => {
    const { app, user } = await createHarness({ withUser: true });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD })
      .expect(200);

    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.user.email).toBe(user.email);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('normalises the email to lowercase', async () => {
    const { app, store } = await boot();
    const account = await seedUser(store, { email: 'miXed@example.com' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'MiXeD@Example.COM', password: TEST_PASSWORD })
      .expect(200);
    expect(res.body.user.email).toBe(account.email);
  });

  it('rejects a wrong password with 401', async () => {
    const { app, user } = await createHarness({ withUser: true });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'totally-wrong' })
      .expect(401);
    expect(res.body.error.message).toMatch(/incorrect email or password/i);
  });

  it('rejects regular (non-admin) accounts', async () => {
    const { app, store } = await boot();
    const account = await seedUser(store, { role: 'user' });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: account.email, password: TEST_PASSWORD })
      .expect(401);
    expect(res.body.error.message).toMatch(/incorrect email or password/i);
  });

  it('does not reveal whether an account exists', async () => {
    const { app } = await boot();
    const missing = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'whatever123' })
      .expect(401);
    expect(missing.body.error.message).toBe('Incorrect email or password.');
  });

  it('rejects invalid payloads', async () => {
    const { app } = await boot();
    const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email' }).expect(422);
    const issues = (res.body.error.details as { issues: Array<{ path: string }> }).issues;
    expect(issues.some((i) => i.path === 'email')).toBe(true);
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current admin for a valid token', async () => {
    const { app, token, user } = await createHarness({ withUser: true });
    const res = await request(app).get('/api/auth/me').set(auth(token)).expect(200);
    expect(res.body.user.id).toBe(user.id);
  });

  it('rejects a token belonging to a non-admin account', async () => {
    const { app, store } = await boot();
    const account = await seedUser(store, { role: 'user' });
    const token = signToken({ sub: account.id, email: account.email, name: account.name });

    await request(app).get('/api/auth/me').set(auth(token)).expect(401);
  });

  it('rejects a missing token', async () => {
    const { app } = await boot();
    const res = await request(app).get('/api/auth/me').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed token', async () => {
    const { app } = await boot();
    const res = await request(app).get('/api/auth/me').set(auth('not.a.jwt')).expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a token signed with the wrong secret', async () => {
    const { app } = await boot();
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsImVtYWlsIjoiYWRtaW5AZXhhbXBsZS5jb20ifQ.bogus-signature';
    const res = await request(app).get('/api/auth/me').set(auth(forged)).expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('anonymous access', () => {
  it('serves the workspace routes without any token', async () => {
    const { app } = await boot();
    await request(app).get('/api/documents').expect(200);
    await request(app).get('/api/health/me/stats').expect(200);
  });

  it('keeps /api/auth/me behind admin authentication', async () => {
    const { app } = await boot();
    await request(app).get('/api/auth/me').expect(401);
  });

  it('rejects an invalid bearer token instead of silently serving the public workspace', async () => {
    const { app } = await boot();
    const res = await request(app).get('/api/documents').set(auth('not.a.jwt')).expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});
