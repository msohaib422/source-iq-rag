/**
 * Shared test helpers: an isolated app instance backed by a fresh MemoryStore,
 * plus helpers for provisioning accounts and uploading a real generated PDF.
 *
 * Authentication is admin-only, so tests seed accounts directly in the store
 * (there is no public registration endpoint).
 */
import type { Express } from 'express';
import request from 'supertest';
import { AppContext } from '../src/context.js';
import { MemoryStore } from '../src/db/memory.js';
import { getOrCreatePublicWorkspaceUser } from '../src/services/accounts.js';
import { hashPassword, signToken } from '../src/services/auth.js';
import type { UserRecord } from '../src/types/domain.js';

export interface TestHarness {
  app: Express;
  store: MemoryStore;
  token: string;
  user: { id: string; email: string; name: string };
  /** Owner of the shared knowledge base (the public workspace account). */
  kbId: string;
}

export const TEST_PASSWORD = 'password123';

/** Provision an account directly, exactly as boot-time admin bootstrap does. */
export async function seedUser(
  store: MemoryStore,
  overrides: { email?: string; name?: string; password?: string; role?: 'user' | 'admin' } = {},
): Promise<UserRecord> {
  return store.createUser({
    email: overrides.email ?? `user-${Math.random().toString(36).slice(2, 10)}@example.com`,
    name: overrides.name ?? 'Test User',
    passwordHash: await hashPassword(overrides.password ?? TEST_PASSWORD),
    role: overrides.role ?? 'admin',
  });
}

/** Minimal but genuinely valid single-page PDF, generated on the fly. */
export function makePdf(textLines: string[], title = 'SourceIQ Test Document'): Buffer {
  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = [
    'BT',
    '/F1 12 Tf',
    '72 720 Td',
    '14 TL',
    ...textLines.map((line) => `(${escape(line)}) Tj T*`),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/** Build an app bound to a fresh in-memory store, optionally with an admin session. */
export async function createHarness(options: { withUser?: boolean } = {}): Promise<TestHarness> {
  const store = new MemoryStore();
  await store.init();
  const kb = await getOrCreatePublicWorkspaceUser(store);
  const context = new AppContext(store);

  // Each harness gets its own app instance whose container is bound to the app,
  // so two harnesses coexist without sharing users, documents or tokens.
  const { createApp } = await import('../src/app.js');
  const app = createApp(context);

  if (!options.withUser) {
    return { app, store, kbId: kb.id, token: '', user: { id: '', email: '', name: '' } };
  }

  // The admin session: seed an admin account and sign a token for it, matching
  // what the login route issues.
  const account = await seedUser(store);
  const token = signToken({ sub: account.id, email: account.email, name: account.name });

  return {
    app,
    store,
    kbId: kb.id,
    token,
    user: { id: account.id, email: account.email, name: account.name },
  };
}

export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** Upload a generated PDF as the given user and return the API response. */
export async function uploadPdf(
  app: Express,
  token: string,
  textLines: string[],
  filename = 'guide.pdf',
): Promise<request.Response> {
  const buffer = makePdf(textLines);
  return request(app)
    .post('/api/documents')
    .set(auth(token))
    .attach('file', buffer, { filename, contentType: 'application/pdf' });
}