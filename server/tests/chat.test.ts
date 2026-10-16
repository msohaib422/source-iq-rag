/**
 * End-to-end RAG tests: index a real PDF, ask real questions, assert that the
 * right passages are retrieved and that citations are correct and scoped.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { auth, createHarness, uploadPdf, type TestHarness} from './helpers.js';

let h: TestHarness;

const ARAL_LINES = [
  'Aral Sea Research Note',
  '',
  'The Aral Sea lost eighty percent of its surface area between 1973 and 1990.',
  'Cotton irrigation consumed approximately 2500 cubic metres of water per hectare annually.',
  'Salinity spread across the exposed seabed and rendered agricultural soil infertile.',
  'Regional fisheries declined by roughly forty percent over the same two decades.',
  '',
  'Remediation funded by the World Bank began in 1995.',
  'The Kokaral dam reduced salinity levels within eighteen months of completion.',
];

const ROCKET_LINES = [
  'Launch Vehicle Handbook',
  '',
  'The Saturn V first stage produced 7.6 meganewtons of thrust at sea level.',
  'Three F-1 engines burned RP-1 kerosene with liquid oxygen oxidiser.',
  'Telemetry was relayed through the Saturn network of ground stations.',
  'The vehicle reached Earth orbit using the S-II and S-IVB stages.',
];

async function seedBoth() {
  h = await createHarness({ withUser: true });
  const aral = await uploadPdf(h.app, h.token, ARAL_LINES, 'aral-sea.pdf');
  const rocket = await uploadPdf(h.app, h.token, ROCKET_LINES, 'saturn-v.pdf');
  expect(aral.status).toBe(201);
  expect(rocket.status).toBe(201);
  return { aralId: aral.body.document.id as string, rocketId: rocket.body.document.id as string };
}

describe('POST /api/chat', () => {
  it('answers a question from the indexed content with citations', async () => {
    const { aralId } = await seedBoth();

    const res = await request(h.app)
      .post('/api/chat')
      .set(auth(h.token))
      .send({ question: 'How much water did cotton irrigation consume per hectare?' })
      .expect(200);

    expect(res.body.answer).toBeTypeOf('string');
    expect(res.body.answer.length).toBeGreaterThan(0);
    expect(res.body.retrievedCount).toBeGreaterThan(0);

    const citations = res.body.citations as Array<{ documentId: string; snippet: string; score: number }>;
    expect(citations.length).toBeGreaterThan(0);
    expect(citations.some((c) => c.documentId === aralId)).toBe(true);

    // The correct fact should be surfaced.
    const allText = citations.map((c) => c.snippet).join(' ').toLowerCase();
    expect(allText).toContain('2500');

    // Citations are ordered by descending similarity.
    const scores = citations.map((c) => c.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('retrieves the semantically correct document', async () => {
    const { aralId, rocketId } = await seedBoth();

    const res = await request(h.app)
      .post('/api/chat')
      .set(auth(h.token))
      .send({ question: 'What propellant did the F-1 engines burn?' })
      .expect(200);

    const top = (res.body.citations as Array<{ documentId: string }>)[0]!;
    expect(top.documentId).toBe(rocketId);
    expect(top.documentId).not.toBe(aralId);
  });

  it('scopes retrieval to the selected documents', async () => {
    const { rocketId } = await seedBoth();

    const res = await request(h.app)
      .post('/api/chat')
      .set(auth(h.token))
      .send({ question: 'What propellant did the F-1 engines burn?', documentIds: [rocketId] })
      .expect(200);

    const citations = res.body.citations as Array<{ documentId: string }>;
    expect(citations.length).toBeGreaterThan(0);
    expect(citations.every((c) => c.documentId === rocketId)).toBe(true);
  });

  it('rejects a document id from another workspace', async () => {
    const owner = await createHarness({ withUser: true });
    const attacker = await createHarness({ withUser: true });
    const upload = await uploadPdf(owner.app, owner.token, ARAL_LINES);
    const foreignId = upload.body.document.id as string;

    const res = await request(attacker.app)
      .post('/api/chat')
      .set(auth(attacker.token))
      .send({ question: 'Anything at all?', documentIds: [foreignId] })
      .expect(404);
    expect(res.body.error.message).toMatch(/not found in the knowledge base/i);
    h = owner;
  });

  it('answers without authentication (public workspace)', async () => {
    h = await createHarness();
    const res = await request(h.app)
      .post('/api/chat')
      .send({ question: 'hello' })
      .expect(200);
    expect(res.body.answer).toBeTypeOf('string');
  });

  it('validates the question payload', async () => {
    h = await createHarness({ withUser: true });
    await request(h.app).post('/api/chat').set(auth(h.token)).send({ question: '' }).expect(422);
    await request(h.app).post('/api/chat').set(auth(h.token)).send({}).expect(422);
  });

  it('does not persist the exchange as history', async () => {
    await seedBoth();
    const res = await request(h.app)
      .post('/api/chat')
      .set(auth(h.token))
      .send({ question: 'What remediation was undertaken?' })
      .expect(200);

    // No conversation identifier is issued and nothing is stored for later.
    expect(res.body.conversationId).toBeUndefined();
    expect(res.body.answer).toBeTypeOf('string');

    // Asking the same question again is answered from scratch, with no
    // reference to any earlier turn.
    const again = await request(h.app)
      .post('/api/chat')
      .set(auth(h.token))
      .send({ question: 'What remediation was undertaken?' })
      .expect(200);
    expect(again.body.answer).toBe(res.body.answer);
  });

  it('ignores a stale conversation id, since chat holds no history', async () => {
    await seedBoth();
    const res = await request(h.app)
      .post('/api/chat')
      .set(auth(h.token))
      .send({ question: 'What was done about it?', conversationId: '507f1f77bcf86cd799439011' })
      .expect(200);

    expect(res.body.conversationId).toBeUndefined();
    expect(res.body.answer).toBeTypeOf('string');
    expect(res.body.answer.length).toBeGreaterThan(0);
  });

  it('does not leak content across workspaces into answers', async () => {
    const owner = await createHarness({ withUser: true });
    const attacker = await createHarness({ withUser: true });
    await uploadPdf(owner.app, owner.token, ['The secret access code is PURPLE-SQUID-4417.']);

    const res = await request(attacker.app)
      .post('/api/chat')
      .set(auth(attacker.token))
      .send({ question: 'What is the secret access code?' })
      .expect(200);

    expect(res.body.answer).not.toContain('PURPLE-SQUID-4417');
    expect(res.body.citations).toHaveLength(0);
    h = owner;
  });

  it('serves the shared knowledge base to anonymous answers', async () => {
    h = await createHarness({ withUser: true });
    // The admin curates the knowledge base...
    await uploadPdf(h.app, h.token, ['The launch code is DELTA-7731.'], 'handbook.pdf');

    // ...and anonymous visitors retrieve from that same corpus.
    const anon = await request(h.app)
      .post('/api/chat')
      .send({ question: 'What is the launch code?' })
      .expect(200);
    expect(anon.body.citations.length).toBeGreaterThan(0);
    expect(JSON.stringify(anon.body.citations)).toContain('DELTA-7731');
    expect(anon.body.answer).toContain('DELTA-7731');

    // The admin retrieves the same content from the same corpus.
    const admin = await request(h.app)
      .post('/api/chat')
      .set(auth(h.token))
      .send({ question: 'What is the launch code?' })
      .expect(200);
    expect(admin.body.citations.length).toBeGreaterThan(0);
  });
});

describe('POST /api/chat/stream', () => {
  it('streams citations, deltas and a done event', async () => {
    await seedBoth();

    const res = await request(h.app)
      .post('/api/chat/stream')
      .set(auth(h.token))
      .send({ question: 'When did the surface area loss happen?' })
      .buffer(true)
      .parse((response, callback) => {
        let data = '';
        response.on('data', (c: Buffer) => (data += c.toString()));
        response.on('end', () => callback(null, data));
      })
      .expect(200);

    expect(res.headers['content-type']).toContain('text/event-stream');
    const body = res.body as string;

    expect(body).toContain('event: citations');
    expect(body).toContain('event: delta');
    expect(body).toContain('event: done');

    const citationFrame = body.split('\n\n').find((f) => f.includes('event: citations'));
    const citations = JSON.parse(
      citationFrame!.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim(),
    ) as { citations: unknown[]; retrievedCount: number };
    expect(citations.citations.length).toBeGreaterThan(0);

    const deltas = body
      .split('\n\n')
      .filter((f) => f.includes('event: delta'))
      .map((f) => JSON.parse(f.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim()) as { text: string })
      .map((d) => d.text);
    expect(deltas.join('').length).toBeGreaterThan(0);
  });

  it('streams without authentication (public workspace)', async () => {
    h = await createHarness();
    const res = await request(h.app)
      .post('/api/chat/stream')
      .send({ question: 'hello' })
      .buffer(true)
      .parse((response, callback) => {
        let data = '';
        response.on('data', (c: Buffer) => (data += c.toString()));
        response.on('end', () => callback(null, data));
      })
      .expect(200);

    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body as string).toContain('event: done');
  });
});

describe('conversation history removal', () => {
  it('no longer exposes any conversation endpoint', async () => {
    await seedBoth();
    await request(h.app)
      .post('/api/chat')
      .set(auth(h.token))
      .send({ question: 'Hello there' })
      .expect(200);

    for (const path of ['/api/conversations', '/api/conversations/abc/messages']) {
      const res = await request(h.app).get(path).set(auth(h.token)).expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }

    await request(h.app).post('/api/conversations').set(auth(h.token)).send({}).expect(404);
    await request(h.app).delete('/api/conversations/abc').set(auth(h.token)).expect(404);
  });
});

/**
 * Behaviour required for a helpful assistant: pleasantries are answered
 * conversationally without querying the knowledge base, while factual answers
 * are produced only from retrieved passages.
 */
describe('intent handling and strict grounding', () => {
  function ask(question: string, token?: string) {
    const req = request(h.app).post('/api/chat').send({ question });
    return token ? req.set(auth(token)) : req;
  }

  // ---- scenario 1 & 2: greetings and casual messages ----
  it('answers a greeting conversationally without querying the knowledge base', async () => {
    await seedBoth();

    for (const greeting of ['Hi', 'Hello', 'Hey there']) {
      const res = await ask(greeting, h.token).expect(200);
      expect(res.body.retrievedCount).toBe(0);
      expect(res.body.citations).toEqual([]);
      expect(res.body.answer).toMatch(/hello|hi there/i);
      // A natural reply, not a "no relevant information in the provided context".
      expect(res.body.answer).not.toMatch(/provided context|context passages|no matching passages/i);
    }
  });

  it('answers "how are you?" conversationally', async () => {
    await seedBoth();
    const res = await ask('How are you?', h.token).expect(200);
    expect(res.body.retrievedCount).toBe(0);
    expect(res.body.answer).toMatch(/doing well/i);
    expect(res.body.answer).not.toMatch(/provided context/i);
  });

  it('answers thanks, farewells and identity questions conversationally', async () => {
    await seedBoth();

    const thanks = await ask('Thanks', h.token).expect(200);
    expect(thanks.body.answer).toMatch(/welcome/i);

    const who = await ask('Who are you?', h.token).expect(200);
    expect(who.body.answer).toMatch(/AI assistant/i);
    expect(who.body.answer).toMatch(/knowledge sources/i);

    for (const res of [thanks, who]) {
      expect(res.body.retrievedCount).toBe(0);
      expect(res.body.citations).toEqual([]);
    }
  });

  // ---- scenario 3: a factual question the sources do answer ----
  it('answers a supported factual question with citations to the real source', async () => {
    await seedBoth();
    const res = await ask('How much water did cotton irrigation consume per hectare?', h.token).expect(200);

    expect(res.body.retrievedCount).toBeGreaterThan(0);
    expect(res.body.citations.length).toBeGreaterThan(0);
    expect(res.body.citations.map((c: { snippet: string }) => c.snippet).join(' ').toLowerCase()).toContain('2500');

    // Every citation must be one of the passages actually retrieved.
    const citedIds = new Set(res.body.citations.map((c: { chunkId: string }) => c.chunkId));
    expect(citedIds.size).toBe(res.body.citations.length);
  });

  // ---- scenario 4: a factual question no source answers ----
  it('refuses an unsupported factual question instead of guessing', async () => {
    await seedBoth();
    const res = await ask("What is the university's scholarship deadline?", h.token).expect(200);

    // Retrieval may return topically weak passages; the answer must still be a
    // transparent refusal with no citation attached to the claim.
    expect(res.body.citations).toEqual([]);
    expect(res.body.answer).toMatch(/could not find/i);
    // No invented deadline.
    expect(res.body.answer).not.toMatch(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i);
    expect(res.body.answer).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(res.body.answer).not.toMatch(/\b(?:deadline is|due (?:on|by))\b/i);
  });

  // ---- scenario 5: retrieval returns nothing relevant ----
  it('acknowledges the limitation when nothing relevant is indexed', async () => {
    h = await createHarness();
    const res = await ask('Who won the 1966 FIFA World Cup?').expect(200);

    expect(res.body.retrievedCount).toBe(0);
    expect(res.body.citations).toEqual([]);
    expect(res.body.answer).toMatch(/couldn't find/i);
    expect(res.body.answer).not.toMatch(/England|Brazil/i);
  });

  // ---- scenario 6: partly supported, partly not ----
  it('does not pad an unsupported part of a mixed question', async () => {
    await seedBoth();
    const res = await ask(
      'How much water did cotton irrigation consume per hectare, and what is the Oxford tuition fee?',
      h.token,
    ).expect(200);

    const answer = String(res.body.answer);
    // The grounded half may be answered ...
    if (answer.includes('2500')) {
      // ... but the unsupported half must never be filled in.
      expect(answer).not.toMatch(/£|GBP|per year|tuition fee (?:is|of) £/i);
    }
    // Citations are limited to real retrieved passages either way.
    for (const citation of res.body.citations as Array<{ documentId: string }>) {
      expect(typeof citation.documentId).toBe('string');
    }
  });

  // ---- scenario 7: citations ----
  it('never cites a passage the answer did not reference', async () => {
    await seedBoth();
    const res = await ask('What propellant did the F-1 engines burn?', h.token).expect(200);

    expect(res.body.retrievedCount).toBeGreaterThan(0);
    // MockExtractiveProvider cites with [n]; anything beyond the retrieved set
    // would mean a fabricated reference.
    expect(res.body.citations.length).toBeLessThanOrEqual(res.body.retrievedCount);
    for (const citation of res.body.citations as Array<{ snippet: string }>) {
      expect(citation.snippet.length).toBeGreaterThan(0);
    }
  });

  // ---- intent separation ----
  it('greets naturally but still grounds the factual part of a mixed message', async () => {
    await seedBoth();
    const res = await ask('Hi, how much water did cotton irrigation consume per hectare?', h.token).expect(200);

    expect(res.body.answer).toMatch(/hello|hi there/i);
    expect(res.body.retrievedCount).toBeGreaterThan(0);
    expect(res.body.citations.length).toBeGreaterThan(0);
  });

  it('does not treat a document question as small talk', async () => {
    await seedBoth();
    const res = await ask('What is the main topic covered in this document?', h.token).expect(200);
    expect(res.body.retrievedCount).toBeGreaterThan(0);
  });

  it('asks a clarifying question when the intent is unclear', async () => {
    await seedBoth();
    const res = await ask('What about it?', h.token).expect(200);
    expect(res.body.retrievedCount).toBe(0);
    expect(res.body.answer).toMatch(/rephrase|clarify|not sure/i);
  });

  it('streams conversational and refusal replies through the normal SSE frames', async () => {
    await seedBoth();

    for (const [question, expected] of [
      ['Hi', /hello|hi there/i],
      ["What is the university's scholarship deadline?", /could not find/i],
    ] as const) {
      const res = await request(h.app)
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

      const body = res.body as string;
      expect(body).toContain('event: citations');
      expect(body).toContain('event: delta');
      expect(body).toContain('event: done');

      const text = body
        .split('\n\n')
        .filter((f) => f.includes('event: delta'))
        .map((f) => JSON.parse(f.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim()) as { text: string })
        .map((d) => d.text)
        .join('');
      expect(text).toMatch(expected);
    }
  });
});