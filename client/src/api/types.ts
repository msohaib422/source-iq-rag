/** Types mirroring the server's domain models. */

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
  createdAt: string;
}

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

/**
 * Persisted Firecrawl job state (mirrors the server's WebsiteCrawlState).
 * Progress is driven client-side: each poll of POST /api/websites/:id/advance
 * returns the updated document carrying this state.
 */
export interface WebsiteCrawlState {
  jobId: string;
  /** Firecrawl job status; `failed`/`cancelled` are terminal on their side. */
  status: 'scraping' | 'completed' | 'failed' | 'cancelled';
  /** Our pipeline phase: `indexing` runs once the Firecrawl job completes. */
  phase: 'scraping' | 'indexing' | 'completed' | 'failed';
  crawled: number;
  discovered: number | null;
  indexed: number;
  failedDetail: string | null;
  /** Last transient API error; the next poll retries automatically. */
  lastError: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

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
  /** 'pdf' for uploads, 'website' for Firecrawl crawls (absent on legacy rows). */
  sourceType?: 'pdf' | 'website';
  /** Submitted seed URL for website crawls. */
  websiteUrl?: string | null;
  /** Crawl job state; only present on website documents. */
  crawl?: WebsiteCrawlState | null;
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
  /** 'pdf' for uploads, 'website' for crawled pages (absent on legacy rows). */
  sourceType?: 'pdf' | 'website';
  /** The crawled page this chunk came from (website chunks only). */
  pageUrl?: string | null;
  /** Page title reported by Firecrawl (website chunks only). */
  pageTitle?: string | null;
  /** Seed URL of the crawl this page belongs to (website chunks only). */
  websiteUrl?: string | null;
}

export interface Citation {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  ordinal: number;
  page: number | null;
  score: number;
  snippet: string;
  /** Crawled page the passage came from (website citations only). */
  pageUrl?: string | null;
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

export interface EvaluationRecord {
  id: string;
  userId: string;
  question: string;
  answer: string;
  retrievedChunkIds: string[];
  retrievedDocumentIds: string[];
  retrievalScores: number[];
  retrievalQuality: string | null;
  faithfulnessScore: number | null;
  answerRelevancyScore: number | null;
  contextPrecision: number | null;
  contextRecall: number | null;
  answerCorrectness: number | null;
  hallucinationFindings: string[];
  retryCount: number;
  selfRagDecisions: string[];
  cragActions: string[];
  processingTimeMs: number | null;
  tokenUsage: number | null;
  estimatedCost: number | null;
  mode: 'online' | 'offline';
  benchmarkId: string | null;
  createdAt: string;
}

export interface EvaluationStats {
  total: number;
  avgFaithfulness: number | null;
  avgAnswerRelevancy: number | null;
  avgContextPrecision: number | null;
  avgContextRecall: number | null;
  avgAnswerCorrectness: number | null;
  retrievalSuccessRate: number | null;
  hallucinationRate: number | null;
  avgLatencyMs: number | null;
  avgRetryCount: number | null;
  totalTokens: number;
  estimatedCost: number | null;
}

export interface EvaluationListResponse {
  items: EvaluationRecord[];
  total: number;
}