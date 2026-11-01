import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { auth, createHarness, uploadPdf } from './helpers.js';

describe('RAG evaluation endpoints', () => {
  it('records an evaluation after a chat query', async () => {
    const h = await createHarness({ withUser: true });
    await uploadPdf(h.app, h.token, ['The launch code is DELTA-7731.'], 'handbook.pdf');

    await request(h.app).post('/api/chat').set(auth(h.token)).send({ question: 'What is the launch code?' }).expect(200);

    const stats = await request(h.app).get('/api/evaluations/stats').set(auth(h.token)).expect(200);
    expect(stats.body.stats.total).toBeGreaterThan(0);

    const list = await request(h.app).get('/api/evaluations').set(auth(h.token)).expect(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    const id = list.body.items[0].id;
    const detail = await request(h.app).get(`/api/evaluations/${id}`).set(auth(h.token)).expect(200);
    expect(detail.body.evaluation.question).toContain('launch code');
  });

  it('requires auth', async () => {
    const h = await createHarness();
    await request(h.app).get('/api/evaluations/stats').expect(401);
  });

  it('config toggle works', async () => {
    const h = await createHarness({ withUser: true });
    const res = await request(h.app).patch('/api/evaluations/config').set(auth(h.token)).send({ selfRagEnabled: false }).expect(200);
    expect(res.body.config.selfRagEnabled).toBe(false);
    // restore
    await request(h.app).patch('/api/evaluations/config').set(auth(h.token)).send({ selfRagEnabled: true });
  });
});