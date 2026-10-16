/**
 * Application container.
 *
 * Owns the single Store instance and the citation-title cache that the RAG layer
 * reads to label sources. Routes reach it through `req.ctx`, so tests can swap
 * in a fresh MemoryStore without touching module-level globals.
 */
import { env, resolveStoreDriver } from './config/env.js';
import { MemoryStore } from './db/memory.js';
import { MongoStore } from './db/mongo.js';
import type { Store } from './db/store.js';
import { setDocumentTitleResolver } from './services/rag.js';

export class AppContext {
  readonly store: Store;
  private readonly titles = new Map<string, string>();

  constructor(store?: Store) {
    this.store = store ?? AppContext.createStore();
    setDocumentTitleResolver((documentId) => this.titles.get(documentId) ?? null);
  }

  static createStore(): Store {
    return resolveStoreDriver(env) === 'atlas' ? new MongoStore() : new MemoryStore();
  }

  /** Resolve and cache document titles so citations render real names. */
  async primeDocumentTitles(userId: string, documentIds: string[]): Promise<void> {
    const missing = documentIds.filter((id) => !this.titles.has(id));
    await Promise.all(
      missing.map(async (id) => {
        const doc = await this.store.getDocument(id, userId);
        this.titles.set(id, doc?.title ?? 'Untitled document');
      }),
    );
  }

  invalidateTitle(documentId: string): void {
    this.titles.delete(documentId);
  }

  clearCaches(): void {
    this.titles.clear();
  }
}

let context: AppContext | null = null;

export function getContext(): AppContext {
  if (!context) context = new AppContext();
  return context;
}

/** Test seam: install or clear the process-wide context. */
export function setContext(ctx: AppContext | null): void {
  context = ctx;
}