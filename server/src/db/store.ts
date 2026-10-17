/**
 * Datastore contract.
 *
 * SourceIQ has exactly two implementations:
 *
 *  - `MongoStore`  - production. MongoDB Atlas + Atlas Vector Search ($vectorSearch).
 *  - `MemoryStore` - development / CI. Pure in-process, including a real cosine
 *                    similarity vector index so the full RAG path is exercised
 *                    without any external service.
 *
 * Both are held to the same contract, so routes and services are written once
 * and behave identically under either driver.
 */
import type {
  ChunkRecord,
  DocumentRecord,
  QueryRecord,
  QueryRecordStatus,
  ScoredChunk,
  StoreStats,
  UserRecord,
  VectorIndexStatus,
  VectorSearchParams,
} from '../types/domain.js';

export interface CreateUserInput {
  email: string;
  name: string;
  passwordHash: string;
  role?: 'user' | 'admin';
}

export interface CreateDocumentInput {
  userId: string;
  title: string;
  originalName: string;
  storagePath: string | null;
  mimeType: string;
  sizeBytes: number;
}

export interface CreateChunkInput {
  documentId: string;
  userId: string;
  ordinal: number;
  text: string;
  embedding: number[];
  page: number | null;
  charStart: number | null;
  charEnd: number | null;
}

export interface ListDocumentsOptions {
  search?: string;
  status?: DocumentRecord['status'];
}

export interface ListChunksOptions {
  limit?: number;
  skip?: number;
}

export interface CreateUnansweredQueryInput {
  userId: string;
  question: string;
}

export interface ListUnansweredQueriesOptions {
  status?: QueryRecordStatus;
}

export interface Store {
  readonly driver: 'atlas' | 'memory';
  init(): Promise<void>;
  close(): Promise<void>;
  /** True when the datastore can answer `$vectorSearch` natively. */
  readonly nativeVectorSearch: boolean;

  // ---- users ----
  createUser(input: CreateUserInput): Promise<UserRecord>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;

  // ---- documents ----
  createDocument(input: CreateDocumentInput): Promise<DocumentRecord>;
  listDocuments(userId: string, options?: ListDocumentsOptions): Promise<DocumentRecord[]>;
  getDocument(id: string, userId: string): Promise<DocumentRecord | null>;
  updateDocument(id: string, userId: string, patch: Partial<DocumentRecord>): Promise<DocumentRecord | null>;
  deleteDocument(id: string, userId: string): Promise<boolean>;

  // ---- chunks ----
  insertChunks(chunks: CreateChunkInput[]): Promise<ChunkRecord[]>;
  listChunks(documentId: string, options?: ListChunksOptions): Promise<ChunkRecord[]>;
  getChunk(id: string, userId: string): Promise<ChunkRecord | null>;
  updateChunk(id: string, userId: string, patch: Partial<Pick<ChunkRecord, 'text' | 'embedding' | 'edited'>>): Promise<
    ChunkRecord | null
  >;
  deleteChunk(id: string, userId: string): Promise<boolean>;
  deleteChunksByDocument(documentId: string, userId: string): Promise<number>;
  countChunksByDocument(documentId: string): Promise<number>;
  /** Recompute cached chunkCount on a document (Mongo aggregation). */
  syncChunkCounts(documentId: string): Promise<number>;

  // ---- vector search ----
  vectorSearch(params: VectorSearchParams): Promise<ScoredChunk[]>;

  // ---- unanswered queries (Queries Management) ----
  createUnansweredQuery(input: CreateUnansweredQueryInput): Promise<QueryRecord>;
  listUnansweredQueries(userId: string, options?: ListUnansweredQueriesOptions): Promise<QueryRecord[]>;
  getUnansweredQuery(id: string, userId: string): Promise<QueryRecord | null>;
  updateUnansweredQuery(
    id: string,
    userId: string,
    patch: Partial<Pick<QueryRecord, 'editedQuestion' | 'status'>>,
  ): Promise<QueryRecord | null>;
  deleteUnansweredQuery(id: string, userId: string): Promise<boolean>;
  countUnansweredQueries(userId: string, status?: QueryRecordStatus): Promise<number>;

  // ---- diagnostics ----
  stats(): Promise<StoreStats>;
  /** Cheap connectivity probe: true when the datastore can serve queries. */
  isConnected(): boolean;
  /** Last known vector-index state (cached; see refreshVectorIndexStatus). */
  getVectorIndexStatus(): VectorIndexStatus;
  /**
   * Probe the vector search index and cache the result briefly. Never throws:
   * probe failures are recorded as `ready: null` (unknown) with a detail
   * message so health endpoints can report the real state honestly.
   */
  refreshVectorIndexStatus(force?: boolean): Promise<VectorIndexStatus>;
}