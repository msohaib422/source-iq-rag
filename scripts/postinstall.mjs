#!/usr/bin/env node
/**
 * Root postinstall hook.
 *
 * IMPORTANT: this does NOT download the embedding model. Downloading ~133 MB of
 * ONNX weights automatically would make `npm install` slow and network
 * dependent, and would silently couple install to Hugging Face availability.
 *
 * Instead we only verify that the optional ONNX Runtime native binary that
 * @huggingface/transformers ships resolved locally. If it is missing we print
 * the exact remediation command and continue - the server prints a clear error
 * at boot if the runtime is genuinely unavailable.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const serverDir = join(repoRoot, 'server');

const installed = existsSync(join(repoRoot, 'node_modules')) || existsSync(join(serverDir, 'node_modules'));

if (!installed) {
  process.exit(0);
}

/**
 * Resolve onnxruntime-node the way Node will at runtime. Works whether npm
 * hoisted it to the root node_modules (workspace default) or left it under
 * server/node_modules.
 */
let ortResolved = false;
try {
  const require = createRequire(join(repoRoot, 'package.json'));
  require.resolve('onnxruntime-node');
  ortResolved = true;
} catch {
  try {
    const require = createRequire(join(serverDir, 'package.json'));
    require.resolve('onnxruntime-node');
    ortResolved = true;
  } catch {
    ortResolved = false;
  }
}

if (ortResolved) {
  console.log('[postinstall] onnxruntime-node resolved locally. OK.');
} else {
  console.log('[postinstall] onnxruntime-node could not be resolved.');
  console.log('[postinstall] Local embedding inference will fail until it is installed. Fix with:');
  console.log('[postinstall]   npm install onnxruntime-node --workspace server');
}

console.log('[postinstall] Next: copy .env.example -> .env, then run "npm run model:download".');