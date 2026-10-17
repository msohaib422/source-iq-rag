/**
 * Unanswered-query collection.
 *
 * A chat question the RAG pipeline could not ground - the answer carried no
 * citation because no indexed chunk sufficiently supports it - is recorded
 * here for the admin's Queries Management page. The admin later edits or
 * discards the record itself; nothing here ever touches documents, chunks,
 * embeddings or prompts.
 *
 * Records live under the shared knowledge-base owner (`userId`), following the
 * same workspace scoping as documents and chunks.
 */
import type { Store } from '../db/store.js';

/**
 * Record a chat query that could not be answered.
 *
 * Duplicates of a still-pending question collapse into the first record (the
 * pending text *is* the user's question, so equality is checked on trimmed
 * case-folded text); a question the admin already edited is a separate record.
 * Failures are logged, never thrown: the chat answer is already in flight and
 * a datastore hiccup must not be reported to the user as a chat failure.
 */
export async function recordUnansweredQuery(store: Store, userId: string, question: string): Promise<void> {
  const text = question.trim();
  if (!text) return;
  try {
    const pending = await store.listUnansweredQueries(userId, { status: 'pending' });
    const key = text.toLowerCase();
    if (pending.some((record) => record.question.trim().toLowerCase() === key)) return;
    await store.createUnansweredQuery({ userId, question: text });
  } catch (err) {
    console.warn(`  ! could not record unanswered query: ${(err as Error).message}`);
  }
}
