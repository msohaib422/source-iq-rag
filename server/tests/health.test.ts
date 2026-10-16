import request from 'supertest';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../src/middleware/errors.js';
import { auth, createHarness, uploadPdf, type TestHarness} from './helpers.js';

let h: TestHarness;

describe('GET /api/health', () => {
  it('reports the mandated embedding model configuration without auth', async () => {
    h = await createHarness();
    const res = await request(h.app).get('/api/health').expect(200);

    expect(res.body.status).toBe('ok');
    expect(res.body.embedding.expectedModel).toBe('BAAI/bge-small-en-v1.5');
    expect(res.body.embedding.dimensions).toBe(384);
    expect(res.body.embedding.pooling).toBe('cls');
    expect(res.body.embedding.normalize).toBe(true);
    expect(res.body.embedding.queryInstruction).toContain('searching relevant passages');
    expect(res.body.store.driver).toBe('memory');
    expect(res.body.store.connected).toBe(true);
    // The vector index state is probed, not assumed from configuration.
    expect(res.body.vectorSearch.backend).toBe('memory');
    expect(res.body.vectorSearch.ready).toBe(true);
    expect(res.body.llm.provider).toBe('mock');
  });

  it('does not leak secrets', async () => {
    h = await createHarness();
    const body = JSON.stringify((await request(h.app).get('/api/health')).body);
    expect(body).not.toContain(process.env.JWT_SECRET);
    expect(body.toLowerCase()).not.toContain('api_key');
    expect(body).not.toContain('privatekey');
  });
});

describe('GET /api/health/ready', () => {
  it('confirms the local model produces 384-dim unit vectors', async () => {
    h = await createHarness();
    const res = await request(h.app).get('/api/health/ready').expect(200);

    expect(res.body.status).toBe('ready');
    expect(res.body.problems).toEqual([]);
    expect(res.body.embedding.probe.dimensions).toBe(384);
    expect(res.body.embedding.probe.expectedDimensions).toBe(384);
    expect(res.body.embedding.probe.finite).toBe(true);
    expect(Math.abs(res.body.embedding.probe.l2Norm - 1)).toBeLessThan(1e-4);
    expect(res.body.store.vectorSearchBackend).toBe('in-memory');
    expect(res.body.vectorSearch.backend).toBe('memory');
    expect(res.body.vectorSearch.ready).toBe(true);
    expect(res.body.runtime.node).toBeTypeOf('string');
  });
});

describe('GET /api/health/me/stats', () => {
  it('serves public workspace counters without authentication', async () => {
    h = await createHarness();
    const res = await request(h.app).get('/api/health/me/stats').expect(200);
    expect(res.body.documents).toBe(0);
    expect(res.body.chunks).toBe(0);
  });

  it('returns workspace counters for the signed-in admin', async () => {
    h = await createHarness({ withUser: true });
    const res = await request(h.app).get('/api/health/me/stats').set(auth(h.token)).expect(200);
    expect(res.body.documents).toBe(0);
    expect(res.body.chunks).toBe(0);
  });

  it('counts the shared knowledge base for the admin and anonymous visitors alike', async () => {
    const admin = await createHarness({ withUser: true });
    await uploadPdf(admin.app, admin.token, ['Landing page copy for the marketing site.']);

    const asAdmin = await request(admin.app).get('/api/health/me/stats').set(auth(admin.token)).expect(200);
    const asAnon = await request(admin.app).get('/api/health/me/stats').expect(200);

    expect(asAdmin.body.documents).toBe(1);
    expect(asAdmin.body.chunks).toBeGreaterThan(0);
    expect(asAnon.body.documents).toBe(1);
    expect(asAnon.body.chunks).toBeGreaterThan(0);
    h = admin;
  });
});

describe('error handling', () => {
  it('returns a structured 404 for unknown routes', async () => {
    h = await createHarness();
    const res = await request(h.app).get('/api/does-not-exist').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toContain('/api/does-not-exist');
  });

  it('returns 400 for malformed JSON', async () => {
    h = await createHarness();
    const res = await request(h.app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": ')
      .expect(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
  });

  it('returns a stable, machine-readable error envelope', async () => {
    h = await createHarness();
    const res = await request(h.app).get('/api/does-not-exist').expect(404);
    // The 404 fallthrough deliberately returns a clean envelope with no stack.
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.body.error.stack).toBeUndefined();
    expect(Object.keys(res.body)).toEqual(['error']);
  });

  it('never leaks stack traces, even on rejected management attempts', async () => {
    h = await createHarness();
    const res = await request(h.app)
      .post('/api/documents')
      .attach('file', Buffer.from('%PDF-1.4\n'), 'x.pdf')
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.stack).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('node_modules');
  });

  it('maps a datastore pre-connection failure to a clean 503', async () => {
    const app = express();
    const err = new Error(
      'Cannot call `users.findOne()` before initial connection is complete if `bufferCommands = false`.',
    );
    err.name = 'MongooseError';
    app.get('/api/boom', () => {
      throw err;
    });
    app.use(errorHandler);

    const res = await request(app).get('/api/boom').expect(503);
    expect(res.body.error.code).toBe('STORE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('bufferCommands');
    expect(JSON.stringify(res.body)).not.toContain('mongoose');
  });

  it('keeps unexpected failures generic instead of echoing internals', async () => {
    const app = express();
    app.get('/api/boom', () => {
      throw new Error('internal detail from /secret/path');
    });
    app.use(errorHandler);

    const res = await request(app).get('/api/boom').expect(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('An unexpected error occurred.');
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});