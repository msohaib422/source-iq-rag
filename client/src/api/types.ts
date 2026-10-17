/** Types mirroring the server's domain models. */

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  createdAt: string;
}

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface SourceDocument {
  id: string;
  userId: string;
  title: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  pageCount: number;
  charCount: number;
  chunkCount: number;
  status: DocumentStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Chunk {
  id: string;
  documentId: string;
  userId: string;
  ordinal: number;
  text: string;
  page: number | null;
  charStart: number | null;
  charEnd: number | null;
  edited: boolean;
  createdAt: string;
  updatedAt: string;
  embeddingDimensions?: number;
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

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  createdAt: string;
}

export interface IngestionResult {
  documentId: string;
  status: 'ready' | 'failed';
  pageCount: number;
  charCount: number;
  chunkCount: number;
  dimensions: number;
  elapsedMs: number;
  error?: string;
}

/** A chat query the assistant could not answer, collected for admin review. */
export type QueryStatus = 'pending' | 'indexed';

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
  status: QueryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface QueriesResponse {
  queries: QueryRecord[];
  counts: { pending: number; indexed: number; total: number };
}

export interface HealthInfo {
  status: string;
  service: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
  store: { driver: 'atlas' | 'memory'; dbName: string; configured: boolean };
  embedding: {
    loaded: boolean;
    expectedModel: string;
    dimensions: number;
    pooling: string;
    normalize: boolean;
    queryInstruction: string;
    dtype: string;
    cacheDir: string;
    loadMs?: number;
  };
  llm: { provider: string; model: string; remoteCallsEnabled: boolean };
}

export interface ReadinessInfo {
  status: 'ready' | 'degraded';
  problems: string[];
  embedding: HealthInfo['embedding'] & {
    probe: { dimensions: number; expectedDimensions: number; l2Norm: number; finite: boolean } | null;
  };
  llm: { name: string; model: string; status: string; detail?: string };
  store: { driver: string; users: number; documents: number; chunks: number } | null;
  runtime: { node: string; platform: string; rssMB: number; heapUsedMB: number };
}

export interface WorkspaceStats {
  documents: number;
  chunks: number;
  pages: number;
  /** Unanswered chat queries still awaiting admin review (the Queries card). */
  queries: number;
  ready: number;
  failed: number;
}