#!/usr/bin/env node
/**
 * Create the MongoDB Atlas Vector Search index.
 *
 *   npm run atlas:index
 *
 * Two provisioning paths:
 *
 *  1. Driver path (default, no extra credentials): the MongoDB driver's
 *     `createSearchIndex` / `listSearchIndexes` commands manage Atlas Search
 *     indexes directly. Requires only the existing MONGODB_URI. Creates the
 *     index when it is missing and never touches an existing one.
 *
 *  2. Atlas Admin API (when ATLAS_PUBLIC_KEY / ATLAS_PRIVATE_KEY /
 *     ATLAS_GROUP_ID / ATLAS_CLUSTER_NAME are all set): replaces an existing
 *     index with the current definition. Keep these keys in server/.env when
 *     you need replace semantics; they are never required for first-time setup.
 *
 * The generated definition matches BAAI/bge-small-en-v1.5 exactly:
 *   numDimensions = 384, path = "embedding", similarity = "cosine", filter "userId"
 */
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { MongoStore } from '../src/db/mongo.js';

interface Credentials {
  publicKey: string;
  privateKey: string;
}

interface NativeSearchIndex {
  name?: string;
  status?: string;
  queryable?: boolean;
}

interface NativeSearchIndexCollection {
  listSearchIndexes(): { toArray(): Promise<NativeSearchIndex[]> };
  createSearchIndex(description: unknown): Promise<unknown>;
}

function readCredentials(): Credentials {
  const publicKey = process.env.ATLAS_PUBLIC_KEY?.trim();
  const privateKey = process.env.ATLAS_PRIVATE_KEY?.trim();
  const missing: string[] = [];
  if (!publicKey) missing.push('ATLAS_PUBLIC_KEY');
  if (!privateKey) missing.push('ATLAS_PRIVATE_KEY');
  if (missing.length) {
    throw new Error(`Missing ${missing.join(' and ')}. Create an API key under Atlas → Project Settings → API Keys.`);
  }
  return { publicKey: publicKey as string, privateKey: privateKey as string };
}

async function apiBase(): Promise<string> {
  const groupId = process.env.ATLAS_GROUP_ID?.trim();
  if (!groupId) {
    throw new Error(
      'Missing ATLAS_GROUP_ID. This is the 5-character MongoDB organization ID, shown next to "Project Settings" in the Atlas UI.',
    );
  }
  return `https://cloud.mongodb.com/api/atlas/v2/groups/${groupId}`;
}

function indexDefinition() {
  return {
    name: env.VECTOR_INDEX_NAME,
    type: 'vectorSearch',
    // `userId` must be declared as a filter field so $vectorSearch can scope
    // retrieval per account without pulling other users' chunks into the result.
    fields: [
      {
        type: 'vector',
        path: 'embedding',
        numDimensions: env.EMBEDDING_DIMENSIONS,
        similarity: 'cosine',
      },
      { type: 'filter', path: 'userId' },
    ],
  };
}

function printSummary(): void {
  console.log('');
  console.log('  SourceIQ — Atlas Vector Search index');
  console.log('  ─────────────────────────────────────────────────────────');
  console.log(`  Database      ${env.MONGODB_DB_NAME}`);
  console.log('  Collection    chunks');
  console.log(`  Index         ${env.VECTOR_INDEX_NAME}`);
  console.log('  Path          embedding');
  console.log(`  Dimensions    ${env.EMBEDDING_DIMENSIONS}  (BAAI/bge-small-en-v1.5)`);
  console.log('  Similarity    cosine');
  console.log('  Filter field  userId');
  console.log('');
}

/** Default path: the driver manages the index; only MONGODB_URI is needed. */
async function createViaDriver(): Promise<void> {
  const definition = indexDefinition();
  const store = new MongoStore();
  await store.init();

  const collection = mongoose.connection.collection('chunks') as unknown as NativeSearchIndexCollection;
  const before = await collection.listSearchIndexes().toArray();
  const existing = before.find((i) => i.name === definition.name);

  if (existing) {
    console.log(`  ℹ Index "${definition.name}" already exists (status: ${existing.status ?? 'unknown'}).`);
    console.log('    To replace it with the current definition, configure the ATLAS_* keys and re-run.');
    await store.close();
    return;
  }

  console.log(`  Creating "${definition.name}" via the MongoDB driver (no Admin API key needed) …`);
  await collection.createSearchIndex({
    name: definition.name,
    type: 'vectorSearch',
    definition: { fields: definition.fields },
  });

  // Atlas builds the index asynchronously; poll briefly so the output is actionable.
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const list = await collection.listSearchIndexes().toArray();
    const index = list.find((i) => i.name === definition.name);
    const ready = Boolean(index && (index.queryable === true || index.status === 'READY'));
    console.log(`    … status: ${index?.status ?? 'unknown'}${ready ? ' (queryable)' : ''}`);
    if (ready) break;
  }

  console.log('  ✓ Done. Verify with: GET /api/health/ready');
  console.log('');
  await store.close();
}

/** Optional path: uses the Atlas Admin API (needs the four ATLAS_* variables). */
async function createViaAdminApi(): Promise<void> {
  const definition = indexDefinition();
  const creds = readCredentials();
  const base = await apiBase();
  const auth = Buffer.from(`${creds.publicKey}:${creds.privateKey}`).toString('base64');
  const headers = {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.atlas.2023-01-01+json',
  };

  const clusterName = process.env.ATLAS_CLUSTER_NAME?.trim();
  if (!clusterName) {
    throw new Error(
      'Missing ATLAS_CLUSTER_NAME. The name of your Atlas cluster (Atlas UI → Clusters, the top-left cluster name).',
    );
  }

  console.log(`  Cluster       ${clusterName}`);
  const collectionName = 'chunks';

  const existing = await fetch(`${base}/clusters/${clusterName}/searchIndexes`, { headers });
  if (existing.ok) {
    const list = (await existing.json()) as Array<{ name: string }>;
    const found = list.find((i) => i.name === definition.name);
    if (found) {
      console.log('  ℹ Index already exists — deleting so it can be recreated with the current definition.');
      const del = await fetch(`${base}/clusters/${clusterName}/searchIndexes/${definition.name}`, {
        method: 'DELETE',
        headers,
      });
      if (!del.ok && del.status !== 404) {
        throw new Error(`Could not delete existing index: HTTP ${del.status} ${await del.text()}`);
      }
    }
  }

  const res = await fetch(`${base}/clusters/${clusterName}/searchIndexes`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: definition.name,
      type: definition.type,
      fields: definition.fields,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Atlas rejected the index definition (HTTP ${res.status}):\n${text}`);
  }

  console.log('  ✓ Index submitted. Atlas builds it asynchronously - it becomes queryable');
  console.log('    within a minute or two. Verify with: GET /api/health/ready');
  console.log('');
}

async function main(): Promise<void> {
  if (!env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set. Atlas cannot be targeted without a connection string.');
  }

  printSummary();

  const hasAdminApi = Boolean(
    process.env.ATLAS_PUBLIC_KEY?.trim() &&
      process.env.ATLAS_PRIVATE_KEY?.trim() &&
      process.env.ATLAS_GROUP_ID?.trim() &&
      process.env.ATLAS_CLUSTER_NAME?.trim(),
  );

  console.log(`  Method        ${hasAdminApi ? 'Atlas Admin API (ATLAS_* configured)' : 'MongoDB driver (createSearchIndex)'}`);
  console.log('');

  if (hasAdminApi) {
    await createViaAdminApi();
  } else {
    await createViaDriver();
  }
}

main().catch((err) => {
  console.error('');
  console.error('  ✗ Could not create the Atlas vector index');
  console.error(`    ${(err as Error).message}`);
  console.error('');
  console.error('  Manual alternative (Atlas UI):');
  console.error('    Search Indexes → Create Index → Atlas Vector Search');
  console.error('    JSON editor:');
  console.error(JSON.stringify(indexDefinition(), null, 2));
  console.error('');
  process.exit(1);
});
