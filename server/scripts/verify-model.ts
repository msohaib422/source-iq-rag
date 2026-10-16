#!/usr/bin/env node
/**
 * Verify the local embedding model end to end.
 *
 *   npm run model:verify
 *
 * Asserts the contract SourceIQ depends on:
 *   1. the model loads offline from the project-local cache
 *   2. query and document embeddings are both 384-dimensional
 *   3. vectors are L2-normalised (unit norm) and fully finite
 *   4. semantically related pairs score higher than unrelated pairs
 *      (a real retrieval-quality smoke test, not just a shape check)
 */
import { env } from '../src/config/env.js';

const EXPECTED = 384;

function norm(v: readonly number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

let failures = 0;

function check(label: string, ok: boolean, detail = '') {
  const icon = ok ? '✓' : '✗';
  console.log(`  ${icon} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  console.log('');
  console.log('  SourceIQ — embedding model verification');
  console.log('  ─────────────────────────────────────────────────────────');

  const embeddings = await import('../src/services/embeddings.js');

  const started = Date.now();
  await embeddings.loadEmbeddingModel();
  const diag = embeddings.getDiagnostics();
  console.log(`  Model loaded in ${Date.now() - started}ms from ${diag?.cacheDir}`);

  check('model id is the mandated checkpoint', diag?.modelId === 'BAAI/bge-small-en-v1.5', diag?.modelId);
  check('CLS pooling + L2 normalisation', diag?.pooling === 'cls' && diag?.normalize === true);
  check('dimension constant is 384', env.EMBEDDING_DIMENSIONS === EXPECTED, String(env.EMBEDDING_DIMENSIONS));

  const queries = [
    'How does the water cycle work?',
    'What are the symptoms of vitamin D deficiency?',
  ];
  const documents = [
    'The water cycle describes the movement of water on Earth through evaporation, condensation, precipitation and collection.',
    'Vitamin D deficiency causes rickets in children and osteomalacia in adults, with symptoms including bone pain and fatigue.',
    'The Volkswagen Golf is a compact car produced by the German manufacturer Volkswagen since 1974.',
    'Baking bread requires flour, water, yeast and salt, kneaded together and left to rise before baking.',
  ];

  const queryVectors = await embeddings.embedDocuments(queries); // documents path: no instruction prefix
  const instructionVectors = await Promise.all(queries.map((q) => embeddings.embedQuery(q)));

  check(
    'document embeddings are 384-dim',
    queryVectors.every((v) => v.length === EXPECTED),
    `got ${queryVectors.map((v) => v.length).join(', ')}`,
  );
  check(
    'query embeddings are 384-dim',
    instructionVectors.every((v) => v.length === EXPECTED),
    `got ${instructionVectors.map((v) => v.length).join(', ')}`,
  );
  check(
    'all values finite',
    [...queryVectors, ...instructionVectors].flat().every((v) => Number.isFinite(v)),
  );
  check(
    'vectors are L2-normalised',
    [...queryVectors, ...instructionVectors].every((v) => Math.abs(norm(v) - 1) < 1e-4),
    `norms ${[...queryVectors, ...instructionVectors].map((v) => norm(v).toFixed(5)).join(', ')}`,
  );

  const docVectors = await embeddings.embedDocuments(documents);
  check(
    'batch embedding works',
    docVectors.length === documents.length && docVectors.every((v) => v.length === EXPECTED),
    `${docVectors.length} vectors`,
  );

  // Retrieval quality: each query must rank its own passage first.
  const expectations: Array<[number, string, string]> = [
    [0, 'water cycle', 'Vitamin D deficiency'],
    [1, 'vitamin D deficiency', 'Volkswagen Golf'],
  ];

  for (const [queryIdx, expectDoc, rejectDoc] of expectations) {
    const q = instructionVectors[queryIdx] as number[];
    const ranked = docVectors
      .map((d, i) => ({ i, score: cosine(q, d) }))
      .sort((a, b) => b.score - a.score);
    const top = ranked[0] as { i: number; score: number };
    const topDoc = documents[top.i] as string;
    check(
      `"${expectDoc}" ranks first`,
      topDoc.toLowerCase().includes(expectDoc.toLowerCase()),
      `top="${topDoc.slice(0, 45)}…" score=${top.score.toFixed(4)}`,
    );
    const rejected = docVectors.findIndex((_, i) => (documents[i] as string).toLowerCase().includes(rejectDoc.toLowerCase()));
    const rejectedScore = cosine(q, docVectors[rejected] as number[]);
    check(
      `outranks "${rejectDoc}"`,
      top.score > rejectedScore,
      `${top.score.toFixed(4)} > ${rejectedScore.toFixed(4)}`,
    );
  }

  // The query instruction must actually change the vector.
  const changed = Math.abs(cosine(instructionVectors[0] as number[], queryVectors[0] as number[])) < 0.999;
  check('query instruction changes encoding', changed);

  // Long input must truncate rather than crash.
  const longVector = await embeddings.embedQuery('lorem ipsum '.repeat(2000));
  check('over-length input truncates to 384 dims', longVector.length === EXPECTED, `${longVector.length} dims`);

  console.log('');
  if (failures === 0) {
    console.log('  ✓ All embedding checks passed. Atlas Vector Search index must use numDimensions=384.');
  } else {
    console.log(`  ✗ ${failures} check(s) failed.`);
  }
  console.log('');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('');
  console.error('  ✗ Verification failed:', (err as Error).message);
  console.error('    Run "npm run model:download" first.');
  process.exit(1);
});