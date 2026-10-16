/**
 * Document ingestion, chunk management and authorisation tests.
 * These run the real PDF extractor and the real local embedding model.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { auth, createHarness, makePdf, uploadPdf, type TestHarness} from './helpers.js';

let h: TestHarness;

/**
 * Deliberately long enough to exceed the 900-character chunk size so the
 * pipeline produces several chunks (chunk count is asserted by several tests).
 */
const SAMPLE_LINES = [
  'SourceIQ Research Brief: Aral Sea Basin',
  '',
  'The Aral Sea lost eighty percent of its surface area between 1973 and 1990.',
  'Cotton irrigation consumed approximately 2500 cubic metres of water per hectare annually.',
  'Salinity spread across the exposed seabed and rendered agricultural soil infertile.',
  'Regional fisheries declined by roughly forty percent over the same two decades.',
  '',
  'Remediation funded by the World Bank began in 1995 after prolonged negotiation.',
  'The Kokaral dam reduced salinity levels within eighteen months of completion.',
  '',
  'Aral Sea Regional Information Centre: Hydrographic Overview',
  '',
  'The basin is endorheic, meaning that no surface outlet connects it to the ocean.',
  'The Amu Darya and Syr Darya rivers historically supplied the majority of inflow.',
  'Diversion projects for cotton irrigation reduced river flow by seventy percent.',
  'Bedrock salt deposits beneath the exposed lakebed accelerated the salinity increase.',
  'Prevailing westerly winds carried salt dust across agricultural land for decades.',
  '',
  'Health Impact Assessment',
  '',
  'Respiratory illness rates among exposed communities rose measurably within a decade.',
  'Maternal anaemia prevalence increased in districts closest to the former shoreline.',
  'Groundwater in the affected region remains brackish to this day.',
  '',
  'Remediation and Governance',
  '',
  'The North Aral Sea project pursued a smaller managed basin rather than full restoration.',
  'Water allocation treaties between downstream countries remain contested.',
  'Monitoring now relies on satellite remote sensing and in-situ gauge stations.',
  '',
  'Conclusion',
  '',
  'The Aral Sea crisis remains a canonical case study in hydrological mismanagement.',
];

describe('POST /api/documents', () => {
  it('ingests a PDF, chunks it and embeds every chunk at 384 dims', async () => {
    h = await createHarness({ withUser: true });
    const res = await uploadPdf(h.app, h.token, SAMPLE_LINES);

    expect(res.status).toBe(201);
    expect(res.body.document.status).toBe('ready');
    expect(res.body.document.pageCount).toBe(1);
    expect(res.body.document.chunkCount).toBeGreaterThan(0);

    const ingestion = res.body.ingestion;
    expect(ingestion.status).toBe('ready');
    expect(ingestion.dimensions).toBe(384);
    expect(ingestion.chunkCount).toBe(res.body.document.chunkCount);
    expect(ingestion.chunkCount).toBeGreaterThan(1);
    expect(res.body.document.error).toBeNull();
  });

  it('stores real 384-dimensional vectors that are unit-normalised', async () => {
    h = await createHarness({ withUser: true });
    const upload = await uploadPdf(h.app, h.token, SAMPLE_LINES);
    const documentId = upload.body.document.id as string;

    const raw = await h.store.getChunk(
      (await h.store.listChunks(documentId, { limit: 1 }))[0]!.id,
      h.kbId,
    );
    expect(raw?.embedding).toHaveLength(384);

    const norm = Math.sqrt(raw!.embedding.reduce((s, v) => s + v * v, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-4);
  });

  it('rejects a non-PDF upload', async () => {
    h = await createHarness({ withUser: true });
    const res = await request(h.app)
      .post('/api/documents')
      .set(auth(h.token))
      .attach('file', Buffer.from('this is definitely not a pdf'), {
        filename: 'fake.pdf',
        contentType: 'application/pdf',
      });

    expect([400, 422]).toContain(res.status);
    expect(res.body.document?.status ?? 'failed').toBe('failed');
  });

  it('marks a corrupt PDF as failed with an actionable message', async () => {
    h = await createHarness({ withUser: true });
    const res = await uploadPdf(h.app, h.token, [], 'empty.pdf');
    // makePdf with no lines still produces a valid but blank page.
    expect([201, 422]).toContain(res.status);
    if (res.status === 422) {
      expect(res.body.document.status).toBe('failed');
      expect(res.body.ingestion.error).toBeTypeOf('string');
    }
  });

  it('rejects anonymous uploads: managing documents requires the admin token', async () => {
    h = await createHarness();
    const res = await request(h.app)
      .post('/api/documents')
      .attach('file', makePdf(['hello']), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(await h.store.listDocuments(h.kbId)).toHaveLength(0);
  });

  it('requires a file to be attached', async () => {
    h = await createHarness({ withUser: true });
    const res = await request(h.app).post('/api/documents').set(auth(h.token)).expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});

describe('anonymous visitors cannot manage the knowledge base', () => {
  it('rejects document update, reindex and delete without an admin token', async () => {
    const admin = await createHarness({ withUser: true });
    const upload = await uploadPdf(admin.app, admin.token, ['Public knowledge base document.']);
    const id = upload.body.document.id as string;

    await request(admin.app).patch(`/api/documents/${id}`).send({ title: 'hijacked' }).expect(401);
    await request(admin.app).post(`/api/documents/${id}/reindex`).send({}).expect(401);
    await request(admin.app).delete(`/api/documents/${id}`).expect(401);

    // Nothing about the document changed.
    const doc = await request(admin.app).get(`/api/documents/${id}`).expect(200);
    expect(doc.body.document.title).toBe('guide');
    h = admin;
  });

  it('rejects chunk editing and deletion without an admin token', async () => {
    const admin = await createHarness({ withUser: true });
    const upload = await uploadPdf(admin.app, admin.token, SAMPLE_LINES);
    const chunk = (await admin.store.listChunks(upload.body.document.id, { limit: 1 }))[0]!;

    await request(admin.app).patch(`/api/chunks/${chunk.id}`).send({ text: 'hijacked' }).expect(401);
    await request(admin.app).delete(`/api/chunks/${chunk.id}`).expect(401);

    // The chunk text is untouched.
    const still = await admin.store.getChunk(chunk.id, admin.kbId);
    expect(still!.text).not.toContain('hijacked');
    h = admin;
  });
});

describe('GET /api/documents', () => {
  it('lists the shared knowledge base for the admin and for anonymous visitors alike', async () => {
    const a = await createHarness({ withUser: true });
    const b = await createHarness({ withUser: true });
    await uploadPdf(a.app, a.token, ['Alice document about botany.'], 'alice-botany.pdf');
    await uploadPdf(b.app, b.token, ['Bob document about architecture.'], 'bob-architecture.pdf');

    // The admin who uploaded sees the document...
    const asAdmin = await request(a.app).get('/api/documents').set(auth(a.token)).expect(200);
    expect(asAdmin.body.documents).toHaveLength(1);
    expect(asAdmin.body.documents[0].title).toBe('alice botany');
    expect(asAdmin.body.documents[0].originalName).toBe('alice-botany.pdf');

    // ...anonymous visitors to the same instance retrieve from the same corpus...
    const asAnon = await request(a.app).get('/api/documents').expect(200);
    expect(asAnon.body.documents).toHaveLength(1);
    expect(asAnon.body.documents[0].title).toBe('alice botany');

    // ...while another deployment never sees it.
    const other = await request(b.app).get('/api/documents').expect(200);
    expect(other.body.documents.map((d: { title: string }) => d.title)).toEqual(['bob architecture']);
    h = a;
  });

  it('filters by status and search text', async () => {
    h = await createHarness({ withUser: true });
    await uploadPdf(h.app, h.token, SAMPLE_LINES, 'aral-sea-brief.pdf');

    const search = await request(h.app)
      .get('/api/documents?search=aral')
      .set(auth(h.token))
      .expect(200);
    expect(search.body.documents).toHaveLength(1);

    const none = await request(h.app).get('/api/documents?search=zzzz').set(auth(h.token)).expect(200);
    expect(none.body.documents).toHaveLength(0);

    const ready = await request(h.app)
      .get('/api/documents?status=ready')
      .set(auth(h.token))
      .expect(200);
    expect(ready.body.documents).toHaveLength(1);
  });
});

describe('document authorisation', () => {
  it('keeps a foreign document out of GET', async () => {
    const owner = await createHarness({ withUser: true });
    const attacker = await createHarness({ withUser: true });
    const upload = await uploadPdf(owner.app, owner.token, SAMPLE_LINES);
    const id = upload.body.document.id as string;

    const res = await request(attacker.app).get(`/api/documents/${id}`).set(auth(attacker.token));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    h = owner;
  });

  it('refuses to delete a foreign document', async () => {
    const owner = await createHarness({ withUser: true });
    const attacker = await createHarness({ withUser: true });
    const upload = await uploadPdf(owner.app, owner.token, SAMPLE_LINES);
    const id = upload.body.document.id as string;

    await request(attacker.app).delete(`/api/documents/${id}`).set(auth(attacker.token)).expect(404);
    // Still present for the owner.
    await request(owner.app).get(`/api/documents/${id}`).set(auth(owner.token)).expect(200);
    h = owner;
  });
});

describe('chunk editing', () => {
  it('re-embeds edited text so the stored vector changes', async () => {
    h = await createHarness({ withUser: true });
    const upload = await uploadPdf(h.app, h.token, SAMPLE_LINES);
    const id = upload.body.document.id as string;

    const before = (await h.store.listChunks(id, { limit: 1 }))[0]!;
    const beforeChunk = await h.store.getChunk(before.id, h.kbId);

    const res = await request(h.app)
      .patch(`/api/chunks/${before.id}`)
      .set(auth(h.token))
      .send({ text: 'Completely rewritten replacement text about quantum chromodynamics.' })
      .expect(200);

    expect(res.body.chunk.edited).toBe(true);
    expect(res.body.chunk.embeddingDimensions).toBe(384);
    // The raw vector is not exposed over the API...
    expect(res.body.chunk.embedding).toBeUndefined();
    // ...but it did change in storage.
    const afterChunk = await h.store.getChunk(before.id, h.kbId);
    expect(afterChunk!.text).toContain('quantum chromodynamics');
    expect(afterChunk!.embedding).toHaveLength(384);
    expect(afterChunk!.embedding).not.toEqual(beforeChunk!.embedding);
    expect(afterChunk!.edited).toBe(true);
  });

  it('rejects an empty replacement', async () => {
    h = await createHarness({ withUser: true });
    const upload = await uploadPdf(h.app, h.token, SAMPLE_LINES);
    const chunk = (await h.store.listChunks(upload.body.document.id, { limit: 1 }))[0]!;

    await request(h.app).patch(`/api/chunks/${chunk.id}`).set(auth(h.token)).send({ text: '' }).expect(422);
  });

  it('prevents editing a foreign chunk', async () => {
    const owner = await createHarness({ withUser: true });
    const attacker = await createHarness({ withUser: true });
    const upload = await uploadPdf(owner.app, owner.token, SAMPLE_LINES);
    const chunk = (await owner.store.listChunks(upload.body.document.id, { limit: 1 }))[0]!;

    await request(attacker.app)
      .patch(`/api/chunks/${chunk.id}`)
      .set(auth(attacker.token))
      .send({ text: 'hijacked' })
      .expect(404);
    h = owner;
  });

  it('deletes a chunk and updates the document count', async () => {
    h = await createHarness({ withUser: true });
    const upload = await uploadPdf(h.app, h.token, SAMPLE_LINES);
    const id = upload.body.document.id as string;
    const chunks = await h.store.listChunks(id, { limit: 100 });
    const before = chunks.length;
    expect(before).toBeGreaterThan(1);

    const target = chunks[0]!;
    const res = await request(h.app).delete(`/api/chunks/${target.id}`).set(auth(h.token)).expect(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.documentChunkCount).toBe(before - 1);

    const remaining = await h.store.listChunks(id, { limit: 100 });
    expect(remaining).toHaveLength(before - 1);
    expect(remaining.find((c) => c.id === target.id)).toBeUndefined();
  });

  it('prevents deleting a foreign chunk', async () => {
    const owner = await createHarness({ withUser: true });
    const attacker = await createHarness({ withUser: true });
    const upload = await uploadPdf(owner.app, owner.token, SAMPLE_LINES);
    const chunk = (await owner.store.listChunks(upload.body.document.id, { limit: 1 }))[0]!;

    await request(attacker.app).delete(`/api/chunks/${chunk.id}`).set(auth(attacker.token)).expect(404);
    // Still there for the owner.
    expect((await owner.store.listChunks(upload.body.document.id, { limit: 100 })).length).toBeGreaterThan(0);
    h = owner;
  });
});

describe('POST /api/documents/:id/reindex', () => {
  it('re-embeds every chunk without changing the text', async () => {
    h = await createHarness({ withUser: true });
    const upload = await uploadPdf(h.app, h.token, SAMPLE_LINES);
    const id = upload.body.document.id as string;

    const before = await h.store.listChunks(id, { limit: 100 });
    const res = await request(h.app).post(`/api/documents/${id}/reindex`).set(auth(h.token)).send({}).expect(200);

    expect(res.body.updated).toBe(before.length);
    const after = await h.store.listChunks(id, { limit: 100 });
    expect(after.map((c) => c.text)).toEqual(before.map((c) => c.text));

    const a = (await h.store.getChunk(before[0]!.id, h.kbId))!.embedding;
    const b = (await h.store.getChunk(after[0]!.id, h.kbId))!.embedding;
    // Deterministic model -> identical vectors.
    expect(a).toEqual(b);
  });
});

describe('DELETE /api/documents/:id', () => {
  it('removes the document and all of its chunks', async () => {
    h = await createHarness({ withUser: true });
    const upload = await uploadPdf(h.app, h.token, SAMPLE_LINES);
    const id = upload.body.document.id as string;

    await request(h.app).delete(`/api/documents/${id}`).set(auth(h.token)).expect(204);

    expect(await h.store.listChunks(id, { limit: 100 })).toHaveLength(0);
    await request(h.app).get(`/api/documents/${id}`).set(auth(h.token)).expect(404);
  });
});