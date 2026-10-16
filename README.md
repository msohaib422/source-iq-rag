# SourceIQ

Upload PDFs, ask questions, get answers that cite the exact chunk they came from.

SourceIQ is a MERN application whose **embeddings run entirely on your machine** using
[`BAAI/bge-small-en-v1.5`](https://huggingface.co/BAAI/bge-small-en-v1.5) — no hosted embedding API, no global
installs, no Python.

**Anyone can chat and search the shared library with no account at all.** Managing it — uploading, editing,
re-embedding and deleting documents or chunks — is reserved for the single **admin** account and enforced
server-side on every management route.

The UI mirrors that split: `/` is a minimal public chat (input, answers, citations — no dashboard, statistics,
health or management), and `/admin` is the administrative dashboard with navigation, diagnostics and document and
chunk management. Signing in switches between them; the admin keeps access to the same chat.

```
React 19 + Vite  ──►  Express 4 + TypeScript  ──►  MongoDB Atlas (Vector Search)
   (client/)                                      (server/)
                          │
                          └──► Transformers.js + ONNX Runtime
                                BAAI/bge-small-en-v1.5 · 384 dims · CLS pooling
```

---

## Table of contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
- [Download the embedding model](#download-the-embedding-model)
- [Configure](#configure)
- [Run](#run)
- [MongoDB Atlas setup](#mongodb-atlas-setup)
- [LLM providers](#llm-providers)
- [Tests](#tests)
- [Verification status](#verification-status)
- [Production build](#production-build)
- [How the retrieval pipeline works](#how-the-retrieval-pipeline-works)
- [Project layout](#project-layout)
- [Scripts reference](#scripts-reference)
- [Troubleshooting](#troubleshooting)

---

## What it does

1. **Ingest (admin)** — upload a PDF; text is extracted page-by-page, split into overlapping chunks, and each chunk is
   embedded into a 384-dimensional vector that is persisted alongside its metadata.
2. **Search** — questions are embedded with the same model and retrieved with Atlas Vector Search
   (`$vectorSearch`, cosine similarity).
3. **Answer** — the retrieved passages are passed to an LLM that must cite the passages it used. The UI shows the
   answer, the cited snippets, similarity scores and page numbers.
4. **Correct (admin)** — edit or delete any chunk; edited text is re-embedded immediately so the index never drifts
   from what you can read. Anonymous visitors get the same library read-only.

---

## Requirements

| | |
|---|---|
| **Node.js** | ≥ 20.11 (developed and verified on 22.x) |
| **npm** | ≥ 10 (ships with Node 20+) |
| **Disk** | ~1.2 GB for `node_modules`, plus ~130 MB for the model |
| **RAM** | ~600 MB steady state while serving (ONNX Runtime + Express + Mongo driver) |
| **Python** | **Not required.** The project is pure JavaScript/TypeScript. |

> There is no `requirements.txt` by design. Every component — including local embedding inference — runs on Node.

---

## Install

All dependencies are **project-local** via npm workspaces. Nothing is installed globally.

```bash
git clone <your-repo-url> SourceIQ
cd SourceIQ
npm install
```

This creates a single hoisted `node_modules/` at the repo root with `server/` and `client/` linked as workspaces.
`npm install -g` is never required or used.

> **Lockfiles:** npm workspaces use a *single* `package-lock.json` at the repo root covering both workspaces. It is
> committed. Use `npm ci` for a byte-for-byte reproducible install.
>
> **No `requirements.txt`:** the project is pure JavaScript/TypeScript. Local embedding inference runs on
> `onnxruntime-node` through Transformers.js, so no Python interpreter, virtualenv or pip package is involved.

---

## Download the embedding model

The model is **not** downloaded automatically during `npm install` — a ~133 MB download that couples installation to
network availability would make setup fragile. Fetch it explicitly:

```bash
npm run model:download
```

Expected output:

```
  Model        BAAI/bge-small-en-v1.5
  Cache dir    server/models
  ▸ Fetching weights from huggingface.co (first run downloads ~133 MB) …
    tokenizer.json … 100%
    onnx/model.onnx … 100%

  ✓ Model ready
    Dimensions  384
    Pooling     CLS + L2 normalisation (matches sentence-transformers)
    Disk used   127.6 MB (cache directory)
```

Verify it actually works — shape, normalisation **and** retrieval quality:

```bash
npm run model:verify
```

```
  ✓ model id is the mandated checkpoint — BAAI/bge-small-en-v1.5
  ✓ document embeddings are 384-dim — got 384, 384
  ✓ vectors are L2-normalised — norms 1.00000, 1.00000, 1.00000, 1.00000
  ✓ "water cycle" ranks first — score=0.8177
  ✓ outranks "Vitamin D deficiency" — 0.8177 > 0.4290
  ✓ query instruction changes encoding
```

Inspect what is cached at any time:

```bash
npm run model:info
```

### Model storage, memory and startup behaviour

| | |
|---|---|
| **Model** | `BAAI/bge-small-en-v1.5` (MIT), 33M parameters, 12-layer BERT encoder |
| **Runtime** | `@huggingface/transformers` 3.x on `onnxruntime-node` (native, local) |
| **Precision** | `fp32` — this checkpoint publishes **only** `onnx/model.onnx`; there is no quantised variant, so fp32 is the correct choice, not a fallback |
| **Dimensions** | **384** (matches `hidden_size` in `config.json`) |
| **Pooling** | **CLS** — `1_Pooling/config.json` sets `pooling_mode_cls_token: true` |
| **Normalisation** | L2 (unit-norm vectors) |
| **Disk** | ~128 MB, written to `server/models/` (gitignored) |
| **First download** | ~133 MB over the network, ~3–5 minutes on a typical connection |
| **Load time** | ~3–4 s cold (first start after download), **~0.5 s** from the local cache |
| **Memory** | ~130 MB for the ONNX session plus inference buffers; ~600 MB RSS for the whole API |
| **Startup** | With `EMBEDDING_PRELOAD=true` (default) weights load **before** the server starts listening, so the first request is never slow. With `STRICT_EMBEDDINGS=true` (default) the process **exits non-zero** if the model cannot load — it never silently degrades to a different model. |

Model artifacts and caches are excluded from Git (`.gitignore`) because they are large and trivially re-downloadable
via `npm run model:download`.

---

## Configure

```bash
cp .env.example .env              # optional, informational
cp server/.env.example server/.env
cp client/.env.example client/.env # optional
```

The minimum for a working local run is **no configuration at all** — the defaults give you the in-memory datastore
and the offline LLM provider. To use Atlas, set `MONGODB_URI`.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | API port |
| `CORS_ORIGINS` | `http://localhost:5173,...` | Allowed browser origins |
| `JWT_SECRET` | dev placeholder | **Change for production.** Boot fails in `production` if unset to the placeholder |
| `ADMIN_EMAIL` | `admin@gmail.com` | The single admin account. Only the admin can sign in |
| `ADMIN_PASSWORD` | `12345678` | **Change for production.** Boot fails in `production` if left at the default |
| `ADMIN_NAME` | `Administrator` | Display name of the admin account |
| `BOOTSTRAP_ADMIN` | `true` | Create/ensure the admin account on boot. There is no public registration |
| `MONGODB_URI` | *(empty)* | Atlas connection string. Empty ⇒ in-memory store |
| `MONGODB_DB_NAME` | `sourceiq` | Database name |
| `EMBEDDING_MODEL_ID` | `BAAI/bge-small-en-v1.5` | Do not change without approval |
| `EMBEDDING_DIMENSIONS` | `384` | Must match the Atlas index `numDimensions` |
| `EMBEDDING_CACHE_DIR` | `./models` | Resolved relative to `server/` |
| `EMBEDDING_PRELOAD` | `true` | Load weights during boot |
| `STRICT_EMBEDDINGS` | `true` | Refuse to start if the model is unavailable |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` | `900` / `150` | Chunking window in characters |
| `VECTOR_INDEX_NAME` | `vector_index` | Must match the Atlas index name |
| `LLM_PROVIDER` | `mock` | `mock` \| `groq` \| `mistral` \| `openrouter` \| `openai` \| `gemini` |
| `LLM_API_KEY` | *(empty)* | Key for the selected provider (or use the provider-specific var) |
| `MAX_UPLOAD_MB` | `25` | Upload size limit |

---

## Run

**Two terminals:**

```bash
# Terminal 1 — API (http://localhost:5000)
npm run dev:server

# Terminal 2 — Vite dev server (http://localhost:5173)
npm run dev:client
```

**Or both at once:**

```bash
npm run dev
```

Then open <http://localhost:5173> and use the app — regular users need no account. Signing in is only for
the single admin account, which is created automatically on first boot (see `ADMIN_EMAIL` / `ADMIN_PASSWORD` below).

> The client talks to the API through a **relative `/api` path** that the Vite dev server proxies to
> `http://127.0.0.1:5000` (`client/vite.config.ts`). There is no hard-coded API URL in the bundle, and no CORS
> round-trip in development. Set `VITE_API_URL` at build time if you need an absolute URL.

Health endpoints:

```bash
curl http://localhost:5000/api/health        # cheap, no auth
curl http://localhost:5000/api/health/ready   # deep: loads the model, embeds a probe vector
```

---

## MongoDB Atlas setup

SourceIQ runs with **zero configuration** by falling back to an in-process datastore. To use Atlas:

**1. Create a dedicated test database.** Never point SourceIQ at a database holding unrelated data.

**2. Put the connection string in `server/.env`:**

```bash
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/sourceiq_test?retryWrites=true&w=majority
MONGODB_DB_NAME=sourceiq_test
```

**3. Create the Vector Search index.** Atlas Search indexes are provisioned out-of-band. The bundled script
creates the index through the MongoDB driver's `createSearchIndex` command — **no Atlas API key required**
(verified against a live cluster):

```bash
npm run atlas:index
```

If the four `ATLAS_*` variables are also set (`ATLAS_PUBLIC_KEY`, `ATLAS_PRIVATE_KEY`, `ATLAS_GROUP_ID`,
`ATLAS_CLUSTER_NAME`), the script switches to the Atlas Admin API instead, which can *replace* an existing index
with the current definition.

Or paste this into **Atlas → Search Indexes → Create Index → Atlas Vector Search → JSON editor**:

```json
{
  "name": "vector_index",
  "type": "vectorSearch",
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 384, "similarity": "cosine" },
    { "type": "filter", "path": "userId" }
  ]
}
```

`numDimensions` **must** be `384` to match `BAAI/bge-small-en-v1.5`. The `userId` filter field lets `$vectorSearch`
scope retrieval per account inside the index rather than filtering after the fact.

Atlas builds the index asynchronously; it becomes queryable within a minute or two. Confirm with
`GET /api/health/ready`.

---

## LLM providers

Embeddings are always local. Only answer *generation* uses an external model, and it is fully pluggable.

| `LLM_PROVIDER` | Endpoint | Default model | Key variable |
|---|---|---|---|
| `mock` | *(none — fully offline)* | `extractive-mock-v1` | — |
| `groq` | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `GROQ_API_KEY` |
| `mistral` | `https://api.mistral.ai/v1` | `mistral-small-latest` | `MISTRAL_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` | `OPENROUTER_API_KEY` |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` | `OPENAI_API_KEY` |
| `gemini` | Google AI Studio | `gemini-2.5-flash` | `GEMINI_API_KEY` |

```bash
# .env
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...
LLM_MODEL=llama-3.3-70b-versatile   # optional override
```

Groq, Mistral, OpenRouter and OpenAI all speak the OpenAI wire format, so they share one implementation driven by
`baseURL`. Any self-hosted OpenAI-compatible gateway (Ollama, vLLM, LiteLLM, Together) works too:

```bash
LLM_PROVIDER=openai
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen2.5
```

The default `mock` provider performs **extractive** answering: it selects the sentences from the retrieved chunks
that best match the question. It is deterministic, needs no key, makes no network calls, and is fully grounded —
which makes the whole application usable and testable with zero external dependencies.

---

## Tests

```bash
npm test               # 93 Vitest tests - embeddings, chunking, auth, ingestion, RAG, chat, streaming
npm run test:coverage  # same, with a V8 coverage report
npm run test:e2e       # 18 Playwright browser tests (real Vite + real API + real model)
npm run verify:restart # 18 checks: full workflow, restart, production boot
npm run test:all       # typecheck + unit/integration + browser E2E
```

The browser suite drives the real Vite dev server against the real API with the real model loaded - nothing is
stubbed:

```bash
npx playwright install chromium   # one-time browser download (project-local cache)
npm run test:e2e
```

It covers the shared-library access model end to end: anonymous visitors chat and receive cited answers without
an account, every anonymous management attempt (upload, edit, re-embed, delete) is rejected with a 401 at the
API and hidden in the UI, the admin signs in, uploads, edits a chunk (the edit is reflected in the next
anonymous retrieval), deletes a chunk, and replaces a document end to end; document scoping restricts the
sources used, admin sign-in/sign-out and session restore work, API-outage error states render, and the layout
holds at 360 / 768 / 1280 px on both desktop and mobile viewports.

`npm run verify:restart` starts the API and the client using the documented commands, exercises admin sign-in ->
upload -> index -> ask -> cite -> readiness-probe, kills both, starts them again and repeats the whole thing,
then boots the compiled `server/dist` in production mode.

---

## Verification status

Everything in this table was executed on this checkout. Results are reported exactly as observed.

| Area | Command | Result |
|---|---|---|
| Dependency install | `npm install` | **616 packages**, project-local only, lockfile written |
| ONNX Runtime resolution | postinstall hook | `onnxruntime-node` resolves locally |
| Model download | `npm run model:download` | **127.6 MB** cached under `server/models/` |
| Model correctness | `npm run model:verify` | **12/12 checks passed** - 384 dims, unit norms, retrieval 0.82 vs 0.43 |
| Typecheck | `npm run typecheck` | **clean** (server + client) |
| Unit / integration | `npm test` | **93/93 passed** |
| Browser E2E | `npm run test:e2e` | **18/18 passed** (desktop + mobile) |
| Restart resilience | `npm run verify:restart` | **18/18 passed** |
| Production build | `npm run build` | client 387 kB + `server/dist/` - **clean** |
| Production boot | via `verify:restart` | compiled server boots, readiness probe green |
| Dev proxy | via `verify:restart` | Vite `/api` -> Express confirmed over HTTP |
| Live MongoDB Atlas | manual run against the real cluster | anonymous cited answer through **real `$vectorSearch`** (cosine score **0.9306**); chunk edit re-embedded and returned by the next anonymous retrieval |
| Atlas index provisioning | `npm run atlas:index` | created `vector_index` via the MongoDB driver (no Admin API key), polled to **READY / queryable** |

### Verified behaviour, concretely

- **384-dimensional vectors** with unit L2 norm, produced by the real ONNX model at runtime.
- **Correct retrieval**: "How deep is the Mariana Trench?" surfaces the 10 994 m passage; "What propellant did
  the F-1 engines burn?" ranks the Saturn V document above the Aral Sea document.
- **Grounded answers**: the answer contains the correct figure and the citations resolve to the right chunk.
- **Chunk edits re-embed**: after editing, the stored vector is verified to have changed, and the new text
  survives a full page reload.
- **Authorisation**: only the admin account can sign in. Documents and chunks live in one shared knowledge base:
  anonymous visitors can read and chat over it, but every management call (upload, update, re-index, delete)
  returns 401 without an admin token and the UI hides those controls.
- **No chat history**: chat is stateless. Neither visitors nor the admin can list, reopen, replay or delete a past
  conversation — there is no history rail, no `New conversation` button and no stored exchange, and every chat
  session starts empty.
- **Live Atlas retrieval**: against the real cluster, an admin upload produced a 384-d embedding, an anonymous
  question was answered from the matching chunk (cosine score **0.9306**), and after an admin chunk edit the
  very next anonymous retrieval returned the edited text.
- **Honest health, no silent failures**: `/api/health` and `/api/health/ready` report `vectorSearch.ready` from
  an actual index probe. Atlas answers `$vectorSearch` with zero rows — not an error — when the index is
  missing; the health check catches that state, marks the service `degraded`, and retrieval fails with an
  actionable message instead of pretending no documents matched.
- **No leaked internals**: error responses never contain stack traces, file paths or driver details.
- **Fail loudly, not silently**: a corrupt PDF is stored as `failed` with an explanatory message instead of
  leaving a half-built index behind.

### Blocked by missing external configuration

One transport remains unexercised because no credentials were available at verification time:

| Area | Blocked on | What to run once credentials exist |
|---|---|---|
| Hosted LLM generation (Groq / Mistral / OpenRouter / OpenAI / Gemini) | provider API key | set `LLM_PROVIDER` + `LLM_API_KEY`, then `npm run dev` |

MongoDB Atlas connectivity and Atlas Vector Search (`$vectorSearch`) **were** exercised against the live cluster
(see the table above). The automated suite runs against the in-memory datastore by design, so **all 93
unit/integration tests and all 18 browser tests are real** - they exercise the real PDF extractor, the real
embedding model and real cosine-similarity ranking. The hosted-LLM transport sits behind the `LlmProvider`
interface, so enabling it is a configuration change rather than a code change; retrieval and citation assembly
are identical for every provider.

---

## Production build

```bash
npm run build      # client → client/dist, server → server/dist
NODE_ENV=production JWT_SECRET="$(openssl rand -hex 32)" npm start
```

The client build emits static files to `client/dist`. Serve them from any static host; forward `/api` to the Node
process (or set `VITE_API_URL` at build time for a separate API origin).

---

## How the retrieval pipeline works

### Embedding preprocessing

BGE models are **not** mean-pooled. `BAAI/bge-small-en-v1.5`'s `1_Pooling/config.json` declares:

```json
{ "pooling_mode_cls_token": true, "pooling_mode_mean_tokens": false, "word_embedding_dimension": 384 }
```

Transformers.js' generic `pipeline('feature-extraction')` applies **mean** pooling, which would silently produce
different vectors from the reference implementation and degrade retrieval. So `server/src/services/embeddings.ts`
loads the tokenizer and model directly and does exactly what `sentence-transformers` does:

```
tokenize (lowercase, WordPiece, truncate to 512, pad)
   → BertModel forward pass
   → take hidden state at position 0        // [CLS]
   → L2 normalise                          // unit-length vector
   → Float32Array[384]
```

Queries and documents share the tokenizer, truncation and pooling; they differ **only** in the instruction prefix
required by the BGE v1.5 model card, which is applied to queries alone:

```
queries:  "Represent this sentence for searching relevant passages: " + question
passages: chunk text, unmodified
```

### Pipeline

```
PDF bytes
  → unpdf (pdf.js)              per-page text + page boundaries
  → normalizeWhitespace          de-hyphenate / unwrap hard line breaks
  → chunkText(900, overlap 150) recursive split on ¶ → \n → sentence → word
  → embedDocuments()             batched (16), CLS + L2 → 384-d
  → store.insertChunks()         Atlas `chunks.embedding`

question
  → embedQuery()                 instruction + CLS + L2 → 384-d
  → $vectorSearch                numCandidates 150, limit 8, cosine, filter userId
  → buildPrompt()                numbered blocks "[1 | source: … | page: … | chunk: …]"
  → LLM (SSE streamed)           must cite [n]
  → alignCitationsToAnswer()     keep only the passages actually referenced
```

Chunk edits re-run `embedDocuments()` on the new text and write the vector in the same request, so the index can
never disagree with the text on screen.

---

## Project layout

```
SourceIQ/
├── package.json                 npm workspaces root (all scripts)
├── package-lock.json            committed — reproducible installs
├── .env.example
├── .gitignore                   node_modules, .env, server/models/, *.onnx
├── scripts/
│   └── postinstall.mjs          verifies onnxruntime-node resolved locally
├── client/                      React 19 + Vite + TypeScript
│   ├── vite.config.ts           /api dev proxy
│   └── src/
│       ├── api/                 typed client, SSE consumer
│       ├── components/          PublicLayout, AdminLayout, UploadZone, ChunkEditor, CitationList, …
│       ├── context/             AuthContext (JWT in localStorage)
│       ├── pages/               Dashboard, Documents, DocumentDetail, Chat, Login
│       └── styles/              design system, responsive
└── server/                      Express 4 + TypeScript
    ├── e2e/                     Playwright browser tests
    ├── scripts/                 download-model · verify-model · model-info · create-atlas-index
    ├── tests/                   Vitest suites
    ├── models/                  model cache (gitignored, ~128 MB)
    └── src/
        ├── config/env.ts        validated env, single source of truth
        ├── db/                  Store contract + MongoStore + MemoryStore
        ├── middleware/          auth, validation, error envelope
        ├── routes/              auth · documents · chunks · chat · health
        ├── services/
        │   ├── embeddings.ts    BGE loader, CLS pooling, normalisation
        │   ├── chunker.ts       recursive character chunking
        │   ├── pdf.ts           text extraction with page boundaries
        │   ├── ingest.ts        the ingestion pipeline
        │   ├── rag.ts           retrieval → prompt → citations
        │   └── llm/             groq/mistral/openrouter/openai/gemini/mock
        └── types/domain.ts      shared domain types
```

### Why there are two datastore implementations

`MongoStore` (Atlas, `$vectorSearch`) and `MemoryStore` (in-process, real cosine search) both implement the same
`Store` interface. Routes and services are written once against that contract, which means the entire RAG path —
ingest, chunk, embed, retrieve, cite — is exercised end to end by the automated suite **without** needing Atlas
credentials. Pointing at Atlas is a one-line config change, not a code change.

---

## Scripts reference

Run from the repo root unless noted.

| Command | What it does |
|---|---|
| `npm install` | Install all workspaces locally |
| `npm run model:download` | Download BAAI/bge-small-en-v1.5 into `server/models/` |
| `npm run model:verify` | Assert 384 dims, unit norms, and retrieval quality |
| `npm run model:info` | Show cache contents and disk usage |
| `npm run dev` | Run API + client together |
| `npm run dev:server` | API only (tsx watch) |
| `npm run dev:client` | Vite dev server only |
| `npm run atlas:index` | Create the Atlas Vector Search index |
| `npm run build` | Production build of both workspaces |
| `npm start` | Run the compiled server |
| `npm run typecheck` | `tsc --noEmit` for both workspaces |
| `npm test` | Vitest suite |
| `npm run test:coverage` | Vitest suite with V8 coverage |
| `npm run test:e2e` | Playwright browser suite |
| `npm run verify:restart` | Restart-resilience + production-boot verification script |
| `npm run test:all` | typecheck + unit + E2E |

---

## Troubleshooting

**`Cannot find module 'onnxruntime-node'`**
The native binary failed to install. Rebuild it locally:
```bash
npm rebuild onnxruntime-node --workspace server
```

**Embedding model fails to load**
```bash
npm run model:download     # re-fetch
npm run model:info         # check the cache
```
The error message lists the cache directory, expected dimensions and the ONNX Runtime status. There is **no
automatic fallback to a different model** — that is deliberate.

**Server exits immediately on boot**
Almost always the model. With `STRICT_EMBEDDINGS=true` (default) the process exits non-zero rather than serving a
broken API. Check the log above the exit.

**`MongoServerSelectionError`**
`MONGODB_URI` is unreachable. Confirm the IP access list in Atlas and that the connection string is correct. Leave
it empty to use the in-memory store.

**Atlas vector search returns nothing**
Atlas answers `$vectorSearch` with **zero rows — not an error — when the index is missing**, so a healthy query
and a broken index look identical from the logs. SourceIQ therefore probes the index directly: `GET /api/health`
reports `vectorSearch.ready` (and `degraded` when it is false), `GET /api/health/ready` lists it under
`problems`, and retrieval fails with an explicit 503 instead of an empty answer. Create the index with
`npm run atlas:index` (no Atlas API key needed); it must use `numDimensions: 384`, `path: "embedding"`,
`similarity: "cosine"`, and `userId` as a `filter` field. Atlas builds it asynchronously — wait a minute, then
re-check readiness.

**Playwright browser missing**
```bash
npx playwright install chromium
```

**Port already in use**
```bash
PORT=5001 npm run dev:server
```
…and point the client at it with `VITE_DEV_API_URL=http://127.0.0.1:5001`.

---

## License

MIT. The bundled model, `BAAI/bge-small-en-v1.5`, is MIT-licensed by BAAI.