/**
 * Unanswered-query collection and the Queries Management API.
 *
 * Recording rules: a *knowledge* question whose completed answer carries no
 * citation (the pipeline found no chunk that supports it) is recorded with its
 * exact text. Small talk, unclear messages, answerable questions and technical
 * failures are never recorded. Management is admin-only: list, edit, delete.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signToken } from '../src/services/auth.js';
import type { QueryRecord } from '../src/types/domain.js';
import { auth, createHarness, seedUser, uploadPdf, type TestHarness } from './helpers.js';

let h: TestHarness;

const ARAL_LINES = [
  'Aral Sea Research Note',
  '',
  'Cotton irrigation consumed approximately 2500 cubic metres of water per hectare annually.',
  'The Kokaral dam reduced salinity levels within eighteen months of completion.',
];

function ask(question: string, token?: string): request.Test {
  const req = request(h.app).post('/api/chat').send({ question });
  return token ? req.set(auth(token)) : req;
}

async function listQueries(params: { status?: string } = {}): Promise<request.Response> {
  const suffix = params.status ? `?status=${params.status}` : '';
  return request(h.app).get(`/api/queries${suffix}`).set(auth(h.token)).expect(200);
}

async function streamAsk(question: string): Promise<request.Response> {
  return request(h.app)
    .post('/api/chat/stream')
    .set(auth(h.token))
    .send({ question })
    .buffer(true)
    .parse((response, callback) => {
      let data = '';
      response.on('data', (c: Buffer) => (data += c.toString()));
      response.on('end', () => callback(null, data));
    })
    .expect(200);
}

describe('recording unanswered queries', () => {
  it('records a knowledge question the empty knowledge base cannot answer, with its exact text', async () => {
    h = await createHarness({ withUser: true });

    const question = 'What is the tuition fee for Oxford University?';
    const res = await ask(question, h.token).expect(200);
    expect(res.body.citations).toEqual([]);

    const { body } = await listQueries();
    expect(body.counts).toEqual({ pending: 1, edited: 0, total: 1 });
    expect(body.queries).toHaveLength(1);
    const record = body.queries[0] as QueryRecord;
    expect(record.question).toBe(question);
    expect(record.editedQuestion).toBeNull();
    expect(record.status).toBe('pending');
    expect(record.createdAt).toBeTypeOf('string');
  });

  it('preserves the submitted text exactly (no paraphrasing, inner spacing intact)', async () => {
    h = await createHarness({ withUser: true });

    // Validation trims the ends, but everything inside is kept verbatim.
    const submitted = '   What is the tuition fee  for Oxford University?   ';
    await ask(submitted, h.token).expect(200);

    const { body } = await listQueries();
    expect((body.queries[0] as QueryRecord).question).toBe('What is the tuition fee  for Oxford University?');
  });

  it('records unanswered questions asked by anonymous visitors into the shared workspace', async () => {
    h = await createHarness({ withUser: true });

    await ask('Who won the 1966 FIFA World Cup?').expect(200);

    // The admin curates what anonymous users left behind.
    const { body } = await listQueries();
    expect(body.counts.pending).toBe(1);
    expect((body.queries[0] as QueryRecord).question).toBe('Who won the 1966 FIFA World Cup?');
  });

  it('records unanswered questions from the streaming endpoint too', async () => {
    h = await createHarness({ withUser: true });

    const res = await streamAsk('What is the tuition fee for Oxford University?');
    expect(res.body as string).toContain('event: done');

    const { body } = await listQueries();
    expect(body.counts.pending).toBe(1);
  });

  it('does not record small talk', async () => {
    h = await createHarness({ withUser: true });

    for (const greeting of ['Hi', 'Hello', 'How are you?']) {
      await ask(greeting, h.token).expect(200);
    }
    const { body } = await listQueries();
    expect(body.queries).toHaveLength(0);
    expect(body.counts.total).toBe(0);
  });

  it('does not record an unclear message', async () => {
    h = await createHarness({ withUser: true });
    await ask('What about it?', h.token).expect(200);

    const { body } = await listQueries();
    expect(body.queries).toHaveLength(0);
  });

  it('does not record a question the knowledge base answers', async () => {
    h = await createHarness({ withUser: true });
    await uploadPdf(h.app, h.token, ARAL_LINES, 'aral-sea.pdf');

    const res = await ask('How much water did cotton irrigation consume per hectare?', h.token).expect(200);
    expect(res.body.citations.length).toBeGreaterThan(0);

    const { body } = await listQueries();
    expect(body.queries).toHaveLength(0);
    expect(body.counts.total).toBe(0);
  });

  it('does not record a technical failure as an unanswered query', async () => {
    h = await createHarness({ withUser: true });

    // Retrieval itself breaks: that is an API problem, not an unanswerable question.
    (h.store as unknown as { vectorSearch: () => Promise<never> }).vectorSearch = () =>
      Promise.reject(new Error('vector backend down'));
    const res = await ask('What is the tuition fee for Oxford University?', h.token);
    expect(res.status).toBeGreaterThanOrEqual(500);

    const { body } = await listQueries();
    expect(body.queries).toHaveLength(0);
  });

  it('collapses duplicate pending questions while keeping distinct ones apart', async () => {
    h = await createHarness({ withUser: true });

    await ask('What is the tuition fee for Oxford University?', h.token).expect(200);
    await ask('What is the tuition fee for Oxford University?', h.token).expect(200);
    // Same question modulo case is still the same pending query...
    await ask('what is the tuition fee for Oxford University?', h.token).expect(200);

    const { body } = await listQueries();
    expect(body.counts.pending).toBe(1);

    // ...but a different question is a distinct record.
    await ask('Who won the 1966 FIFA World Cup?', h.token).expect(200);
    const again = await listQueries();
    expect(again.body.counts.pending).toBe(2);
    expect(again.body.counts.total).toBe(2);
  });
});

describe('authorization', () => {
  it('rejects anonymous visitors on every endpoint', async () => {
    h = await createHarness({ withUser: true });

    await request(h.app).get('/api/queries').expect(401);
    await request(h.app).patch('/api/queries/abc').send({ question: 'x' }).expect(401);
    await request(h.app).delete('/api/queries/abc').expect(401);
  });

  it('rejects tokens of non-admin accounts', async () => {
    h = await createHarness({ withUser: true });
    const user = await seedUser(h.store, { role: 'user' });
    const userToken = signToken({ sub: user.id, email: user.email, name: user.name });

    await request(h.app).get('/api/queries').set(auth(userToken)).expect(401);
    await request(h.app).patch('/api/queries/abc').set(auth(userToken)).send({ question: 'x' }).expect(401);
    await request(h.app).delete('/api/queries/abc').set(auth(userToken)).expect(401);
  });
});

describe('listing', () => {
  it('filters by status and reports accurate section counts', async () => {
    h = await createHarness({ withUser: true });
    await ask('What is the tuition fee for Oxford University?', h.token).expect(200);
    await ask('Who won the 1966 FIFA World Cup?', h.token).expect(200);

    const worldCup = (await listQueries()).body.queries.find(
      (q: QueryRecord) => q.question === 'Who won the 1966 FIFA World Cup?',
    ) as QueryRecord;
    expect(worldCup).toBeTruthy();

    const editedRes = await request(h.app)
      .patch(`/api/queries/${worldCup.id}`)
      .set(auth(h.token))
      .send({ question: 'Which country won the 1966 FIFA World Cup?' })
      .expect(200);
    expect(editedRes.body.query.status).toBe('edited');

    const pending = await listQueries({ status: 'pending' });
    expect(pending.body.queries).toHaveLength(1);
    expect((pending.body.queries[0] as QueryRecord).question).toBe('What is the tuition fee for Oxford University?');
    expect(pending.body.counts).toEqual({ pending: 1, edited: 1, total: 2 });

    const edited = await listQueries({ status: 'edited' });
    expect(edited.body.queries).toHaveLength(1);
    expect((edited.body.queries[0] as QueryRecord).editedQuestion).toBe(
      'Which country won the 1966 FIFA World Cup?',
    );
  });
});

describe('editing', () => {
  it('moves a pending record to Edited while preserving the original submission', async () => {
    h = await createHarness({ withUser: true });
    const question = 'What is the tuition fee for Oxford University?';
    await ask(question, h.token).expect(200);
    const id = (await listQueries()).body.queries[0].id as string;

    const edited = await request(h.app)
      .patch(`/api/queries/${id}`)
      .set(auth(h.token))
      .send({ question: 'What is the tuition fee for international students at Oxford University?' })
      .expect(200)
      .then((res) => res.body.query as QueryRecord);

    expect(edited.editedQuestion).toBe('What is the tuition fee for international students at Oxford University?');
    expect(edited.question).toBe(question);
    expect(edited.status).toBe('edited');
    expect(new Date(edited.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(edited.createdAt).getTime());

    // The record reloads from the store as edited (survives a page refresh).
    const { body } = await listQueries({ status: 'edited' });
    expect((body.queries[0] as QueryRecord).id).toBe(id);
    expect((body.queries[0] as QueryRecord).status).toBe('edited');
    expect((body.queries[0] as QueryRecord).question).toBe(question);
    expect(body.counts).toEqual({ pending: 0, edited: 1, total: 1 });
  });

  it('allows editing an already-edited record without losing the original', async () => {
    h = await createHarness({ withUser: true });
    await ask('What is the tuition fee for Oxford University?', h.token).expect(200);
    const id = (await listQueries()).body.queries[0].id as string;

    await request(h.app)
      .patch(`/api/queries/${id}`)
      .set(auth(h.token))
      .send({ question: 'first phrasing' })
      .expect(200);
    const twice = await request(h.app)
      .patch(`/api/queries/${id}`)
      .set(auth(h.token))
      .send({ question: 'second phrasing' })
      .expect(200)
      .then((res) => res.body.query as QueryRecord);

    expect(twice.editedQuestion).toBe('second phrasing');
    expect(twice.question).toBe('What is the tuition fee for Oxford University?');
  });

  it('rejects an empty edit', async () => {
    h = await createHarness({ withUser: true });
    await ask('What is the tuition fee for Oxford University?', h.token).expect(200);
    const id = (await listQueries()).body.queries[0].id as string;

    await request(h.app).patch(`/api/queries/${id}`).set(auth(h.token)).send({ question: '' }).expect(422);
    await request(h.app).patch(`/api/queries/${id}`).set(auth(h.token)).send({ question: '   ' }).expect(422);

    // The record is untouched and still pending.
    const { body } = await listQueries();
    expect((body.queries[0] as QueryRecord).status).toBe('pending');
    expect(body.counts.pending).toBe(1);
  });

  it('returns 404 for unknown or other-workspace records', async () => {
    h = await createHarness({ withUser: true });
    const other = await createHarness({ withUser: true });
    await request(other.app)
      .post('/api/chat')
      .set(auth(other.token))
      .send({ question: 'What is the tuition fee for Oxford University?' })
      .expect(200);
    const foreignId = (await request(other.app).get('/api/queries').set(auth(other.token)).expect(200))
      .body.queries[0].id as string;

    await request(h.app).patch('/api/queries/507f1f77bcf86cd799439011').set(auth(h.token)).send({ question: 'x' }).expect(404);
    await request(h.app).patch(`/api/queries/${foreignId}`).set(auth(h.token)).send({ question: 'x' }).expect(404);
    h = other;
  });
});

describe('deletion', () => {
  it('removes only the selected record', async () => {
    h = await createHarness({ withUser: true });
    await ask('What is the tuition fee for Oxford University?', h.token).expect(200);
    await ask('Who won the 1966 FIFA World Cup?', h.token).expect(200);

    const records = (await listQueries()).body.queries as QueryRecord[];
    expect(records).toHaveLength(2);
    const target = records[0]!;

    await request(h.app).delete(`/api/queries/${target.id}`).set(auth(h.token)).expect(204);

    const { body } = await listQueries();
    expect(body.counts.total).toBe(1);
    expect(body.queries).toHaveLength(1);
    expect((body.queries[0] as QueryRecord).id).not.toBe(target.id);
  });

  it('returns 404 for unknown or other-workspace records', async () => {
    h = await createHarness({ withUser: true });
    await request(h.app).delete('/api/queries/507f1f77bcf86cd799439011').set(auth(h.token)).expect(404);
    await request(h.app).delete('/api/queries/not-an-id').set(auth(h.token)).expect(404);
  });
});

describe('knowledge base isolation and dashboard counter', () => {
  it('editing or deleting a query never touches documents, chunks or embeddings', async () => {
    h = await createHarness({ withUser: true });
    await uploadPdf(h.app, h.token, ARAL_LINES, 'aral-sea.pdf');
    await ask('What is the tuition fee for Oxford University?', h.token).expect(200);

    const stats = () =>
      request(h.app).get('/api/health/me/stats').set(auth(h.token)).expect(200).then((res) => res.body as Record<string, number>);

    const before = await stats();
    expect(before.queries).toBe(1);
    expect(before.documents).toBe(1);
    const chunksBefore = before.chunks;

    const id = (await listQueries()).body.queries[0].id as string;
    await request(h.app)
      .patch(`/api/queries/${id}`)
      .set(auth(h.token))
      .send({ question: 'What does Oxford cost?' })
      .expect(200);

    const afterEdit = await stats();
    expect(afterEdit.documents).toBe(1);
    expect(afterEdit.chunks).toBe(chunksBefore);
    // The record left Pending, so the dashboard card drops to zero.
    expect(afterEdit.queries).toBe(0);

    await request(h.app).delete(`/api/queries/${id}`).set(auth(h.token)).expect(204);
    const afterDelete = await stats();
    expect(afterDelete.documents).toBe(1);
    expect(afterDelete.chunks).toBe(chunksBefore);
    expect(afterDelete.queries).toBe(0);

    const totals = (await listQueries()).body.counts;
    expect(totals).toEqual({ pending: 0, edited: 0, total: 0 });
  });
});
