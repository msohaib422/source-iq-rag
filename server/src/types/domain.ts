/**
 * Shared domain types.
 *
 * These describe the data as the rest of the application sees it, decoupled
 * from both Mongoose documents and the in-memory representation.
 */

export type UserRole = 'user' | 'admin';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: UserRole;
  createdAt: Date;
}

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface DocumentRecord {
  id: string;
  userId: string;
  title: string;
  originalName: string;
  storagePath: string | null;
  mimeType: string;
  sizeBytes: number;
  pageCount: number;
  charCount: number;
  chunkCount: number;
  status: DocumentStatus;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChunkRecord {
  id: string;
  documentId: string;
  userId: string;
  ordinal: number;
  text: string;
  /** Always EMBEDDING_DIMENSIONS numbers (384 for bge-small-en-v1.5). */
  embedding: number[];
  page: number | null;
  charStart: number | null;
  charEnd: number | null;
  /** True when a human edited the text (so the UI can flag it). */
  edited: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Lifecycle of a Queries Management record.
 *
 *  - `pending` - recorded by the RAG pipeline, still awaiting admin review.
 *  - `indexed` - the admin has marked the query as indexed for tracking
 *    purposes. Nothing is embedded: no document, chunk or vector is created.
 */
export type QueryRecordStatus = 'pending' | 'indexed';

/**
 * A chat question the RAG pipeline could not answer from the indexed chunks.
 *
 * The submitted text is preserved exactly as the user typed it so the admin can
 * see the real question. A record only ever moves between `pending` and
 * `indexed` - it never adds the question to the knowledge base (no document,
 * chunk or embedding is created from Queries Management).
 */
export interface QueryRecord {
  id: string;
  userId: string;
  /** The user's question exactly as submitted (never paraphrased). */
  question: string;
  /**
   * Legacy field from the removed edit workflow. Existing records keep
   * whatever they hold; new records always carry null and nothing writes it.
   */
  editedQuestion: string | null;
  status: QueryRecordStatus;
  createdAt: Date;
  /** Timestamp of the most recent status change; equals createdAt while pending. */
  updatedAt: Date;
}

export interface Citation {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  page: number | null;
  score: number;
  snippet: string;
}

export interface ScoredChunk {
  chunk: ChunkRecord;
  score: number;
}

export interface VectorSearchParams {
  userId: string;
  /** Optional restriction to a subset of documents (chat scoped to a selection). */
  documentIds?: string[];
  queryEmbedding: number[];
  limit: number;
  numCandidates: number;
  /** Drop results scoring below this cosine similarity. */
  minScore?: number;
}

export interface StoreStats {
  users: number;
  documents: number;
  chunks: number;
  vectorSearchBackend: 'atlas' | 'in-memory';
}

/**
 * Honest, probe-backed state of the vector index that retrieval depends on.
 *
 * Atlas answers `$vectorSearch` against a missing index with zero rows instead
 * of an error, so "no results" is not proof of a healthy search backend - the
 * index must be verified separately.
 */
export interface VectorIndexStatus {
  backend: 'atlas' | 'memory';
  indexName: string | null;
  /** true = verified queryable, false = verified missing/not queryable, null = could not verify. */
  ready: boolean | null;
  detail: string;
  checkedAt: string | null;
}