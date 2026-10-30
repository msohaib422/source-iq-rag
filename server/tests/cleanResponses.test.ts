/**
 * Clean response formatting rule, end to end through the chat endpoints.
 *
 * The mock provider answers extractively with [n] markers per passage, so this
 * is a strong demo: the answers the API returns (and the deltas it streams)
 * must be clean prose, while citations keep flowing on the side.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { auth, createHarness, uploadPdf, type TestHarness } from './helpers.js';

let h: TestHarness;

const LINES = [
  'Fee Policy Document',
  '',
  'The annual tuition fee is 2500 pounds as set by the board.',
  'Scholarships cover up to fifty percent for eligible applicants.',
  'Applications open every March and close in June.',
];

const MARKERS = /\[\d{1,2}\]|［\d{1,2}］|【\d{1,2}】|\[\d{1,2}\s*,\s*\d{1,2}\]/g;

describe('clean response formatting through the chat API', () => {
  it('answers without any citation marker in the visible text, citations intact', async () => {
    h = await createHarness({ withUser: true });
    await uploadPdf(h.app, h.token, LINES, 'fees.pdf');

    const res = await request(h.app)
      .post('/api/chat')
      .set(auth(h.token))
      .send({ question: 'How much is the annual tuition fee?' })
      .expect(200);

    expect(res.body.answer).toBeTypeOf('string');
    expect(res.body.answer).not.toMatch(MARKERS);
    // No trailing source section may be appended to the answer.
    expect(res.body.answer).not.toMatch(/sources?\s*:|references?\s*:/i);
    // The grounded fact is still present and citations still resolve to it.
    expect(res.body.answer).toContain('2500');
    expect(res.body.citations.length).toBeGreaterThan(0);
  });

  it('streams clean deltas with no citation marker, yet still sends citations', async () => {
    const res = await request(h.app)
      .post('/api/chat/stream')
      .set(auth(h.token))
      .send({ question: 'What is the annual tuition fee?' })
      .buffer(true)
      .parse((response, callback) => {
        let data = '';
        response.on('data', (c: Buffer) => (data += c.toString()));
        response.on('end', () => callback(null, data));
      })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    const body = res.body as string;
    const frames = body.split('\n\n').filter((frame) => frame.includes('event:'));
    const deltas = frames
      .filter((frame) => frame.includes('event: delta'))
      .map((frame) => JSON.parse(frame.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim()) as { text: string })
      .map((payload) => payload.text)
      .join('');

    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas).not.toMatch(MARKERS);
    expect(deltas).toContain('2500');

    const citationFrame = frames.find((frame) => frame.includes('event: citations'));
    expect(citationFrame).toBeDefined();
    const citations = JSON.parse(citationFrame!.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim()) as {
      citations: unknown[];
    };
    expect(citations.citations.length).toBeGreaterThan(0);
  });

  it('supports comma-joined marker clusters streaming through untouched prose', async () => {
    // The mock emits "[n] sentence" per passage; a question spanning several
    // passages yields consecutive clusters in the raw provider output.
    const res = await request(h.app)
      .post('/api/chat')
      .set(auth(h.token))
      .send({ question: 'Which years do applications open and close, and what do scholarships cover?' })
      .expect(200);

    expect(res.body.answer).not.toMatch(MARKERS);
    expect(res.body.citations.length).toBeGreaterThan(0);
  });
});
