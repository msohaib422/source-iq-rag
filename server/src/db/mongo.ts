/**
 * MongoDB Atlas datastore (Mongoose).
 *
 * Vector retrieval uses Atlas Vector Search (`$vectorSearch`) against a
 * `knnVector` index on `chunks.embedding`. The index is provisioned out-of-band
 * (see `npm run atlas:index`). Atlas answers a search against a missing index
 * with zero rows instead of an error, so this store verifies the index exists
 * and is queryable (`refreshVectorIndexStatus`) and fails retrieval with an
 * explicit 503 rather than pretending "no documents matched".
 */
import mongoose, { Schema } from 'mongoose';
import { env } from '../config/env.js';
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
import type {
  CreateChunkInput,
  CreateDocumentInput,
  CreateUnansweredQueryInput,
  CreateUserInput,
  ListChunksOptions,
  ListDocumentsOptions,
  ListUnansweredQueriesOptions,
  Store,
} from './store.js';
import { serviceUnavailable } from '../utils/errors.js';

const objectId = (v: string | mongoose.Types.ObjectId): mongoose.Types.ObjectId =>
  typeof v === 'string' ? new mongoose.Types.ObjectId(v) : v;

const toId = (v: unknown): string => String(v);

/**
 * Mongoose infers very narrow per-schema document types. We deliberately model
 * the raw layer as a loose record and convert to the strict domain types through
 * the `map*` functions below, so the schemas stay free to change without
 * rippling into the Store contract.
 */
type RawDoc = Record<string, unknown> & { _id: mongoose.Types.ObjectId };
type AnyModel = mongoose.Model<any>;
type PipelineStage = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
  },
  { timestamps: true, collection: 'users' },
);

const documentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: 'User' },
    title: { type: String, required: true, trim: true },
    originalName: { type: String, required: true },
    storagePath: { type: String, default: null },
    mimeType: { type: String, default: 'application/pdf' },
    sizeBytes: { type: Number, required: true, default: 0 },
    pageCount: { type: Number, default: 0 },
    charCount: { type: Number, default: 0 },
    chunkCount: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'processing', 'ready', 'failed'], default: 'pending', index: true },
    error: { type: String, default: null },
  },
  { timestamps: true, collection: 'documents' },
);
documentSchema.index({ userId: 1, createdAt: -1 });

const chunkSchema = new Schema(
  {
    documentId: { type: Schema.Types.ObjectId, required: true, index: true, ref: 'Document' },
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: 'User' },
    ordinal: { type: Number, required: true },
    text: { type: String, required: true },
    // Atlas Vector Search index target. 384 numbers for BAAI/bge-small-en-v1.5.
    embedding: { type: [Number], required: true },
    page: { type: Number, default: null },
    charStart: { type: Number, default: null },
    charEnd: { type: Number, default: null },
    edited: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'chunks' },
);
chunkSchema.index({ documentId: 1, ordinal: 1 });

const querySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true, ref: 'User' },
    // The user's question exactly as submitted; never rewritten by the system.
    question: { type: String, required: true, trim: true },
    // Legacy field from the removed edit workflow; existing documents keep it,
    // nothing writes it anymore.
    editedQuestion: { type: String, default: null },
    // `edited` is the pre-indexing legacy status, accepted so older documents
    // remain writable; init() migrates them to `indexed`.
    status: { type: String, enum: ['pending', 'indexed', 'edited'], default: 'pending', index: true },
  },
  { timestamps: true, collection: 'unanswered_queries' },
);
querySchema.index({ userId: 1, createdAt: -1 });

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

type Doc = RawDoc;

function mapUser(raw: Doc): UserRecord {
  return {
    id: toId(raw._id),
    email: String(raw.email),
    name: String(raw.name),
    passwordHash: String(raw.passwordHash ?? ''),
    role: (raw.role as UserRecord['role']) ?? 'user',
    createdAt: (raw.createdAt as Date) ?? new Date(),
  };
}

function mapDocument(raw: Doc): DocumentRecord {
  return {
    id: toId(raw._id),
    userId: toId(raw.userId),
    title: String(raw.title),
    originalName: String(raw.originalName),
    storagePath: (raw.storagePath as string | null) ?? null,
    mimeType: String(raw.mimeType ?? 'application/pdf'),
    sizeBytes: Number(raw.sizeBytes ?? 0),
    pageCount: Number(raw.pageCount ?? 0),
    charCount: Number(raw.charCount ?? 0),
    chunkCount: Number(raw.chunkCount ?? 0),
    status: (raw.status as DocumentRecord['status']) ?? 'pending',
    error: (raw.error as string | null) ?? null,
    createdAt: (raw.createdAt as Date) ?? new Date(),
    updatedAt: (raw.updatedAt as Date) ?? new Date(),
  };
}

function mapChunk(raw: Doc): ChunkRecord {
  return {
    id: toId(raw._id),
    documentId: toId(raw.documentId),
    userId: toId(raw.userId),
    ordinal: Number(raw.ordinal),
    text: String(raw.text),
    embedding: (raw.embedding as number[]) ?? [],
    page: (raw.page as number | null) ?? null,
    charStart: (raw.charStart as number | null) ?? null,
    charEnd: (raw.charEnd as number | null) ?? null,
    edited: Boolean(raw.edited),
    createdAt: (raw.createdAt as Date) ?? new Date(),
    updatedAt: (raw.updatedAt as Date) ?? new Date(),
  };
}

function mapQuery(raw: Doc): QueryRecord {
  return {
    id: toId(raw._id),
    userId: toId(raw.userId),
    question: String(raw.question),
    // Kept as stored so legacy records never lose data; new records are null.
    editedQuestion: (raw.editedQuestion as string | null) ?? null,
    status: (raw.status as QueryRecord['status']) ?? 'pending',
    createdAt: (raw.createdAt as Date) ?? new Date(),
    updatedAt: (raw.updatedAt as Date) ?? new Date(),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Minimal shape of the driver's Atlas Search index management API. */
interface NativeSearchIndexCollection {
  listSearchIndexes(): { toArray(): Promise<Array<{ name?: string; status?: string; queryable?: boolean }>> };
}

export class MongoStore implements Store {
  readonly driver = 'atlas' as const;
  readonly nativeVectorSearch = true;

  private User: AnyModel;
  private Document: AnyModel;
  private Chunk: AnyModel;
  private Query: AnyModel;

  private vectorIndexStatus: VectorIndexStatus = {
    backend: 'atlas',
    indexName: env.VECTOR_INDEX_NAME,
    ready: null,
    detail: 'Search index state has not been probed yet.',
    checkedAt: null,
  };
  private vectorIndexCheckedAt = 0;

  constructor() {
    this.User = mongoose.models.User ?? mongoose.model('User', userSchema);
    this.Document = mongoose.models.Document ?? mongoose.model('Document', documentSchema);
    this.Chunk = mongoose.models.Chunk ?? mongoose.model('Chunk', chunkSchema);
    this.Query = mongoose.models.UnansweredQuery ?? mongoose.model('UnansweredQuery', querySchema);
  }

  async init(): Promise<void> {
    if (mongoose.connection.readyState === 1) return;
    const uri = env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGODB_URI is required when STORE_DRIVER=atlas.');
    }
    // Fail fast instead of queueing operations for 10s when the cluster is
    // unreachable: the error handler maps these to a clean 503, and
    // `/api/health` reports the real connection state.
    mongoose.set('bufferCommands', false);
    await mongoose.connect(uri, {
      dbName: env.MONGODB_DB_NAME,
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: 10,
    });
    // Ensure the non-vector secondary indexes exist. The Atlas *vector* search
    // index is provisioned separately (npm run atlas:index) because Mongoose
    // does not manage Atlas Search indexes.
    await Promise.all([
      this.User.syncIndexes() as unknown as Promise<unknown>,
      this.Document.syncIndexes() as unknown as Promise<unknown>,
      this.Chunk.syncIndexes() as unknown as Promise<unknown>,
      this.Query.syncIndexes() as unknown as Promise<unknown>,
    ]);
    await this.migrateLegacyEditedQueries();
  }

  /**
   * One-time status transition for records written by the removed edit
   * workflow: legacy `edited` records become `indexed` so they stay available
   * in the Queries page's Indexed section. Only the status field moves - the
   * original question text and every other field are left untouched.
   */
  private async migrateLegacyEditedQueries(): Promise<void> {
    try {
      const res = await this.Query.updateMany({ status: 'edited' }, { $set: { status: 'indexed' } });
      if (res.modifiedCount > 0) {
        console.log(`  i migrated ${res.modifiedCount} legacy edited quer${res.modifiedCount === 1 ? 'y' : 'ies'} to indexed.`);
      }
    } catch (err) {
      // Never fatal: the records stay as stored and a later boot retries.
      console.warn(`  ! legacy query status migration failed: ${(err as Error).message}`);
    }
  }

  async close(): Promise<void> {
    await mongoose.disconnect();
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const doc = await this.User.create({
      email: input.email.toLowerCase(),
      name: input.name,
      passwordHash: input.passwordHash,
      role: input.role ?? 'user',
    });
    return mapUser(doc as Doc);
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const doc = await this.User.findOne({ email: email.toLowerCase() })
      .select('+passwordHash')
      .lean()
      .exec();
    return doc ? mapUser(doc as Doc) : null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await this.User.findById(objectId(id))
      .select('+passwordHash')
      .lean()
      .exec();
    return doc ? mapUser(doc as Doc) : null;
  }

  async createDocument(input: CreateDocumentInput): Promise<DocumentRecord> {
    const doc = await this.Document.create({ ...input, status: 'pending' });
    return mapDocument(doc as Doc);
  }

  async listDocuments(userId: string, options: ListDocumentsOptions = {}): Promise<DocumentRecord[]> {
    if (!mongoose.isValidObjectId(userId)) return [];
    const query: Record<string, unknown> = { userId: objectId(userId) };
    if (options.status) query.status = options.status;
    if (options.search?.trim()) {
      const safe = options.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.$or = [{ title: { $regex: safe, $options: 'i' } }, { originalName: { $regex: safe, $options: 'i' } }];
    }
    const docs = await this.Document.find(query).sort({ createdAt: -1 }).lean().exec();
    return docs.map((d) => mapDocument(d as Doc));
  }

  async getDocument(id: string, userId: string): Promise<DocumentRecord | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await this.Document.findOne({ _id: objectId(id), userId: objectId(userId) }).lean().exec();
    return doc ? mapDocument(doc as Doc) : null;
  }

  async updateDocument(
    id: string,
    userId: string,
    patch: Partial<DocumentRecord>,
  ): Promise<DocumentRecord | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const allowed: Record<string, unknown> = {};
    for (const key of ['title', 'status', 'error', 'pageCount', 'charCount', 'chunkCount', 'storagePath'] as const) {
      if (patch[key] !== undefined) allowed[key] = patch[key];
    }
    const doc = await this.Document.findOneAndUpdate(
      { _id: objectId(id), userId: objectId(userId) },
      { $set: allowed },
      { new: true },
    )
      .lean()
      .exec();
    return doc ? mapDocument(doc as Doc) : null;
  }

  async deleteDocument(id: string, userId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const oid = objectId(id);
    const userOid = objectId(userId);
    const res = await this.Document.deleteOne({ _id: oid, userId: userOid });
    if (res.deletedCount === 0) return false;
    await this.Chunk.deleteMany({ documentId: oid });
    return true;
  }

  async insertChunks(chunks: CreateChunkInput[]): Promise<ChunkRecord[]> {
    if (!chunks.length) return [];
    const docs = await this.Chunk.insertMany(chunks.map((c) => ({ ...c })));
    return docs.map((d) => mapChunk(d as Doc));
  }

  async listChunks(documentId: string, options: ListChunksOptions = {}): Promise<ChunkRecord[]> {
    if (!mongoose.isValidObjectId(documentId)) return [];
    let q = this.Chunk.find({ documentId: objectId(documentId) }).sort({ ordinal: 1 });
    if (options.skip) q = q.skip(options.skip);
    if (options.limit) q = q.limit(options.limit);
    const docs = await q.select('-embedding').lean().exec();
    return docs.map((d) => mapChunk(d as Doc));
  }

  async getChunk(id: string, userId: string): Promise<ChunkRecord | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await this.Chunk.findOne({ _id: objectId(id), userId: objectId(userId) }).lean().exec();
    return doc ? mapChunk(doc as Doc) : null;
  }

  async updateChunk(
    id: string,
    userId: string,
    patch: Partial<Pick<ChunkRecord, 'text' | 'embedding' | 'edited'>>,
  ): Promise<ChunkRecord | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const allowed: Record<string, unknown> = {};
    if (patch.text !== undefined) allowed.text = patch.text;
    if (patch.embedding !== undefined) allowed.embedding = patch.embedding;
    if (patch.edited !== undefined) allowed.edited = patch.edited;
    const doc = await this.Chunk.findOneAndUpdate(
      { _id: objectId(id), userId: objectId(userId) },
      { $set: allowed },
      { new: true },
    )
      .lean()
      .exec();
    return doc ? mapChunk(doc as Doc) : null;
  }

  async deleteChunk(id: string, userId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const res = await this.Chunk.deleteOne({ _id: objectId(id), userId: objectId(userId) });
    return res.deletedCount > 0;
  }

  async deleteChunksByDocument(documentId: string, userId: string): Promise<number> {
    if (!mongoose.isValidObjectId(documentId)) return 0;
    const res = await this.Chunk.deleteMany({ documentId: objectId(documentId), userId: objectId(userId) });
    return res.deletedCount ?? 0;
  }

  async countChunksByDocument(documentId: string): Promise<number> {
    if (!mongoose.isValidObjectId(documentId)) return 0;
    return this.Chunk.countDocuments({ documentId: objectId(documentId) });
  }

  async syncChunkCounts(documentId: string): Promise<number> {
    if (!mongoose.isValidObjectId(documentId)) return 0;
    const count = await this.Chunk.countDocuments({ documentId: objectId(documentId) });
    await this.Document.updateOne({ _id: objectId(documentId) }, { $set: { chunkCount: count } });
    return count;
  }

  async vectorSearch(params: VectorSearchParams): Promise<ScoredChunk[]> {
    // Atlas answers $vectorSearch with zero rows when the index is missing;
    // re-check and fail loudly instead of returning an empty (misleading) result.
    if (this.vectorIndexStatus.ready === false) {
      const status = await this.refreshVectorIndexStatus(true);
      if (status.ready === false) {
        throw serviceUnavailable(`Vector search is unavailable: ${status.detail}`);
      }
    }

    const stages: PipelineStage[] = [
      {
        $vectorSearch: {
          index: env.VECTOR_INDEX_NAME,
          path: 'embedding',
          queryVector: params.queryEmbedding,
          numCandidates: params.numCandidates,
          limit: params.limit,
          // `userId` must be declared as a `filter` path in the Atlas index.
          filter: { userId: objectId(params.userId) },
        },
      },
    ];

    if (params.documentIds?.length) {
      stages.push({ $match: { documentId: { $in: params.documentIds.map((d) => objectId(d)) } } });
    }
    stages.push({
      $project: {
        documentId: 1,
        userId: 1,
        ordinal: 1,
        text: 1,
        embedding: 1,
        page: 1,
        charStart: 1,
        charEnd: 1,
        edited: 1,
        createdAt: 1,
        updatedAt: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    });

    let rows: Doc[];
    try {
      rows = (await this.Chunk.aggregate(stages as unknown as mongoose.PipelineStage[]).exec()) as Doc[];
    } catch (err) {
      throw serviceUnavailable(
        `Atlas Vector Search failed for index "${env.VECTOR_INDEX_NAME}". ` +
          `Create it with dimension ${env.EMBEDDING_DIMENSIONS} (path "embedding", similarity "cosine", ` +
          `filter field "userId") via: npm run atlas:index`,
        { cause: (err as Error)?.message },
      );
    }

    if (rows.length === 0) {
      // An empty result is ambiguous: genuinely no match, or a broken index.
      // Re-probe (at most once per 15 s) before accepting it, so a missing
      // index surfaces as an explicit failure instead of a silent "no sources".
      const stale = Date.now() - this.vectorIndexCheckedAt > 15_000;
      const status = await this.refreshVectorIndexStatus(stale);
      if (status.ready === false) {
        throw serviceUnavailable(`Vector search is unavailable: ${status.detail}`);
      }
    }

    const scored = rows.map((row) => ({ chunk: mapChunk(row), score: Number(row.score ?? 0) }));
    return params.minScore === undefined ? scored : scored.filter((s) => s.score >= params.minScore!);
  }

  // ---- unanswered queries ----

  async createUnansweredQuery(input: CreateUnansweredQueryInput): Promise<QueryRecord> {
    const doc = await this.Query.create({ userId: input.userId, question: input.question, status: 'pending' });
    return mapQuery(doc as Doc);
  }

  async listUnansweredQueries(
    userId: string,
    options: ListUnansweredQueriesOptions = {},
  ): Promise<QueryRecord[]> {
    if (!mongoose.isValidObjectId(userId)) return [];
    const query: Record<string, unknown> = { userId: objectId(userId) };
    if (options.status) query.status = options.status;
    const docs = await this.Query.find(query).sort({ createdAt: -1 }).lean().exec();
    return docs.map((d) => mapQuery(d as Doc));
  }

  async getUnansweredQuery(id: string, userId: string): Promise<QueryRecord | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const doc = await this.Query.findOne({ _id: objectId(id), userId: objectId(userId) }).lean().exec();
    return doc ? mapQuery(doc as Doc) : null;
  }

  async updateUnansweredQuery(
    id: string,
    userId: string,
    patch: Partial<Pick<QueryRecord, 'status'>>,
  ): Promise<QueryRecord | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const allowed: Record<string, unknown> = {};
    if (patch.status !== undefined) allowed.status = patch.status;
    const doc = await this.Query.findOneAndUpdate(
      { _id: objectId(id), userId: objectId(userId) },
      { $set: allowed },
      { new: true },
    )
      .lean()
      .exec();
    return doc ? mapQuery(doc as Doc) : null;
  }

  async deleteUnansweredQuery(id: string, userId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const res = await this.Query.deleteOne({ _id: objectId(id), userId: objectId(userId) });
    return res.deletedCount > 0;
  }

  async countUnansweredQueries(userId: string, status?: QueryRecordStatus): Promise<number> {
    if (!mongoose.isValidObjectId(userId)) return 0;
    const query: Record<string, unknown> = { userId: objectId(userId) };
    if (status) query.status = status;
    return this.Query.countDocuments(query);
  }

  isConnected(): boolean {
    return mongoose.connection.readyState === 1;
  }

  getVectorIndexStatus(): VectorIndexStatus {
    return this.vectorIndexStatus;
  }

  /**
   * Probe the Atlas Search index backing `$vectorSearch`.
   *
   * Atlas returns zero rows (not an error) when the index is missing, so this
   * is the only way to tell "index is broken" from "nothing matched". Results
   * are cached for a minute; pass `force` after a fix to re-check immediately.
   */
  async refreshVectorIndexStatus(force = false): Promise<VectorIndexStatus> {
    if (!force && Date.now() - this.vectorIndexCheckedAt < 60_000) return this.vectorIndexStatus;
    try {
      const native = this.Chunk.collection as unknown as NativeSearchIndexCollection;
      const indexes = await native.listSearchIndexes().toArray();
      const found = indexes.find((i) => i.name === env.VECTOR_INDEX_NAME);
      const queryable = Boolean(found && (found.queryable === true || found.status === 'READY'));
      this.vectorIndexStatus = {
        backend: 'atlas',
        indexName: env.VECTOR_INDEX_NAME,
        ready: queryable,
        detail: found
          ? `Atlas search index "${env.VECTOR_INDEX_NAME}" status: ${found.status ?? (queryable ? 'queryable' : 'unknown')}.`
          : `No Atlas search index named "${env.VECTOR_INDEX_NAME}" exists on the chunks collection; ` +
            '$vectorSearch returns empty results until it is created (npm run atlas:index).',
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      // Public health output stays free of driver internals; log the cause.
      console.warn(`  ! vector index probe failed: ${(err as Error).message}`);
      this.vectorIndexStatus = {
        backend: 'atlas',
        indexName: env.VECTOR_INDEX_NAME,
        ready: null,
        detail: 'Could not inspect Atlas search indexes (datastore unavailable or command unsupported).',
        checkedAt: new Date().toISOString(),
      };
    }
    this.vectorIndexCheckedAt = Date.now();
    return this.vectorIndexStatus;
  }

  async stats(): Promise<StoreStats> {
    const [users, documents, chunks] = await Promise.all([
      this.User.estimatedDocumentCount(),
      this.Document.estimatedDocumentCount(),
      this.Chunk.estimatedDocumentCount(),
    ]);
    return { users, documents, chunks, vectorSearchBackend: 'atlas' };
  }
}