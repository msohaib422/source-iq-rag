/**
 * In-process datastore.
 *
 * Used when MONGODB_URI is not configured and by the automated test-suite. It
 * implements the exact `Store` contract, including a genuine cosine-similarity
 * vector index, so the full RAG pipeline (ingest -> chunk -> embed -> retrieve
 * -> cite) is exercised end to end without any external service.
 *
 * Data is namespaced per test run via `reset()` so suites never leak into
 * each other.
 */
import { randomUUID } from 'node:crypto';
import type {
  ChunkRecord,
  DocumentRecord,
  ScoredChunk,
  StoreStats,
  UserRecord,
  VectorIndexStatus,
  VectorSearchParams,
} from '../types/domain.js';
import type {
  CreateChunkInput,
  CreateDocumentInput,
  CreateUserInput,
  ListChunksOptions,
  ListDocumentsOptions,
  Store,
} from './store.js';
import { cosineSimilarity } from '../services/embeddings.js';

interface Collections {
  users: Map<string, UserRecord>;
  documents: Map<string, DocumentRecord>;
  chunks: Map<string, ChunkRecord>;
}

function emptyCollections(): Collections {
  return {
    users: new Map(),
    documents: new Map(),
    chunks: new Map(),
  };
}

export class MemoryStore implements Store {
  readonly driver = 'memory' as const;
  readonly nativeVectorSearch = false;

  private db = emptyCollections();
  /** userId -> chunk ids, so vector search can scope without a full scan. */
  private indexByUser = new Map<string, Set<string>>();

  async init(): Promise<void> {
    this.reset();
  }

  async close(): Promise<void> {
    this.reset();
  }

  reset(): void {
    this.db = emptyCollections();
    this.indexByUser.clear();
  }

  // ---- users ----

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const email = input.email.toLowerCase();
    if (this.db.users.has(email)) {
      const err = new Error('E11000 duplicate key error collection: users index: email_1') as Error & { code?: number };
      err.code = 11000;
      throw err;
    }
    const user: UserRecord = {
      id: randomUUID(),
      email,
      name: input.name,
      passwordHash: input.passwordHash,
      role: input.role ?? 'user',
      createdAt: new Date(),
    };
    this.db.users.set(email, user);
    return { ...user };
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const user = this.db.users.get(email.toLowerCase());
    return user ? { ...user } : null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    for (const user of this.db.users.values()) {
      if (user.id === id) return { ...user };
    }
    return null;
  }

  // ---- documents ----

  async createDocument(input: CreateDocumentInput): Promise<DocumentRecord> {
    const now = new Date();
    const doc: DocumentRecord = {
      id: randomUUID(),
      userId: input.userId,
      title: input.title,
      originalName: input.originalName,
      storagePath: input.storagePath,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      pageCount: 0,
      charCount: 0,
      chunkCount: 0,
      status: 'pending',
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.documents.set(doc.id, doc);
    return { ...doc };
  }

  async listDocuments(userId: string, options: ListDocumentsOptions = {}): Promise<DocumentRecord[]> {
    const needle = options.search?.trim().toLowerCase();
    return [...this.db.documents.values()]
      .filter((d) => d.userId === userId)
      .filter((d) => (options.status ? d.status === options.status : true))
      .filter((d) =>
        needle ? d.title.toLowerCase().includes(needle) || d.originalName.toLowerCase().includes(needle) : true,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((d) => ({ ...d }));
  }

  async getDocument(id: string, userId: string): Promise<DocumentRecord | null> {
    const doc = this.db.documents.get(id);
    if (!doc || doc.userId !== userId) return null;
    return { ...doc };
  }

  async updateDocument(id: string, userId: string, patch: Partial<DocumentRecord>): Promise<DocumentRecord | null> {
    const doc = this.db.documents.get(id);
    if (!doc || doc.userId !== userId) return null;
    const keys = ['title', 'status', 'error', 'pageCount', 'charCount', 'chunkCount', 'storagePath'] as const;
    for (const key of keys) {
      if (patch[key] !== undefined) (doc as unknown as Record<string, unknown>)[key] = patch[key];
    }
    doc.updatedAt = new Date();
    return { ...doc };
  }

  async deleteDocument(id: string, userId: string): Promise<boolean> {
    const doc = this.db.documents.get(id);
    if (!doc || doc.userId !== userId) return false;
    this.db.documents.delete(id);
    for (const [chunkId, chunk] of this.db.chunks) {
      if (chunk.documentId === id) this.db.chunks.delete(chunkId);
    }
    return true;
  }

  // ---- chunks ----

  private trackChunk(chunk: ChunkRecord) {
    let set = this.indexByUser.get(chunk.userId);
    if (!set) {
      set = new Set();
      this.indexByUser.set(chunk.userId, set);
    }
    set.add(chunk.id);
  }

  async insertChunks(chunks: CreateChunkInput[]): Promise<ChunkRecord[]> {
    const now = new Date();
    const created = chunks.map((c) => {
      const chunk: ChunkRecord = {
        id: randomUUID(),
        documentId: c.documentId,
        userId: c.userId,
        ordinal: c.ordinal,
        text: c.text,
        embedding: [...c.embedding],
        page: c.page,
        charStart: c.charStart,
        charEnd: c.charEnd,
        edited: false,
        createdAt: now,
        updatedAt: now,
      };
      this.db.chunks.set(chunk.id, chunk);
      this.trackChunk(chunk);
      return { ...chunk };
    });
    return created;
  }

  async listChunks(documentId: string, options: ListChunksOptions = {}): Promise<ChunkRecord[]> {
    const all = [...this.db.chunks.values()]
      .filter((c) => c.documentId === documentId)
      .sort((a, b) => a.ordinal - b.ordinal);
    const skip = options.skip ?? 0;
    const limit = options.limit ?? all.length;
    return all.slice(skip, skip + limit).map((c) => ({ ...c, embedding: [] }));
  }

  async getChunk(id: string, userId: string): Promise<ChunkRecord | null> {
    const chunk = this.db.chunks.get(id);
    if (!chunk || chunk.userId !== userId) return null;
    return { ...chunk };
  }

  async updateChunk(
    id: string,
    userId: string,
    patch: Partial<Pick<ChunkRecord, 'text' | 'embedding' | 'edited'>>,
  ): Promise<ChunkRecord | null> {
    const chunk = this.db.chunks.get(id);
    if (!chunk || chunk.userId !== userId) return null;
    if (patch.text !== undefined) chunk.text = patch.text;
    if (patch.embedding !== undefined) chunk.embedding = [...patch.embedding];
    if (patch.edited !== undefined) chunk.edited = patch.edited;
    chunk.updatedAt = new Date();
    return { ...chunk };
  }

  async deleteChunk(id: string, userId: string): Promise<boolean> {
    const chunk = this.db.chunks.get(id);
    if (!chunk || chunk.userId !== userId) return false;
    this.db.chunks.delete(id);
    this.indexByUser.get(chunk.userId)?.delete(id);
    const doc = this.db.documents.get(chunk.documentId);
    if (doc && doc.userId === userId) doc.chunkCount = Math.max(0, doc.chunkCount - 1);
    return true;
  }

  async deleteChunksByDocument(documentId: string, userId: string): Promise<number> {
    let removed = 0;
    for (const [chunkId, chunk] of this.db.chunks) {
      if (chunk.documentId === documentId && chunk.userId === userId) {
        this.db.chunks.delete(chunkId);
        this.indexByUser.get(chunk.userId)?.delete(chunkId);
        removed += 1;
      }
    }
    return removed;
  }

  async countChunksByDocument(documentId: string): Promise<number> {
    let count = 0;
    for (const chunk of this.db.chunks.values()) if (chunk.documentId === documentId) count += 1;
    return count;
  }

  async syncChunkCounts(documentId: string): Promise<number> {
    const count = await this.countChunksByDocument(documentId);
    const doc = this.db.documents.get(documentId);
    if (doc) doc.chunkCount = count;
    return count;
  }

  // ---- vector search ----

  async vectorSearch(params: VectorSearchParams): Promise<ScoredChunk[]> {
    const scope = this.indexByUser.get(params.userId) ?? new Set<string>();
    const allowedDocs = params.documentIds?.length ? new Set(params.documentIds) : null;

    const scored: ScoredChunk[] = [];
    for (const chunkId of scope) {
      const chunk = this.db.chunks.get(chunkId);
      if (!chunk) continue;
      if (allowedDocs && !allowedDocs.has(chunk.documentId)) continue;
      if (chunk.embedding.length !== params.queryEmbedding.length) continue;
      scored.push({ chunk: { ...chunk }, score: cosineSimilarity(chunk.embedding, params.queryEmbedding) });
    }

    scored.sort((a, b) => b.score - a.score);
    const limited = scored.slice(0, params.limit);
    return params.minScore === undefined ? limited : limited.filter((s) => s.score >= params.minScore!);
  }

  async stats(): Promise<StoreStats> {
    return {
      users: this.db.users.size,
      documents: this.db.documents.size,
      chunks: this.db.chunks.size,
      vectorSearchBackend: 'in-memory',
    };
  }

  isConnected(): boolean {
    return true;
  }

  getVectorIndexStatus(): VectorIndexStatus {
    return {
      backend: 'memory',
      indexName: null,
      ready: true,
      detail: 'In-memory cosine similarity - no external search index is involved.',
      checkedAt: null,
    };
  }

  async refreshVectorIndexStatus(): Promise<VectorIndexStatus> {
    return this.getVectorIndexStatus();
  }
}