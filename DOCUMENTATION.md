# The AI Integration Slice — Project Documentation

## 1. What This Is

The AI Integration Slice is a single-flow web application that turns uploaded receipt images or PDFs into structured, validated expense data and, on request, into a plain-language expense summary. A user selects up to five receipt files, submits them, and the app immediately acknowledges the submission, uploads the files to Cloudflare R2 object storage, and creates rows in its own PostgreSQL database. A separate Node worker process running alongside the Next.js app polls those rows and, for each one, downloads the object, sends it to Gemini (`gemini-3.6-flash`) for structured extraction, and stores only the result that passes a Zod schema. The user can then trigger one optional follow-up action — "Summarize this expense" — which sends the already-validated extraction record to DeepSeek (`deepseek-chat`) and displays the returned summary, again only after it passes schema validation. The whole flow is built around honest, auditable job tracking: every job has a real status, attempt count, provider/token usage, and a human-readable error message when something fails.

This project deliberately demonstrates *correct* AI integration discipline rather than an actual product: it is a single-tenant local app with one seeded test user and no login of any kind; every AI call is rate-limited, time-capped, token-capped, concurrency-capped, and validated before it can reach the UI or the database. It uses Next.js with TypeScript throughout, Prisma against PostgreSQL, Zod for every structured input and model output, the official `@google/genai` SDK for the extractor role, the official `openai` SDK pointed at DeepSeek's OpenAI-compatible API for the follow-up role, `@aws-sdk/client-s3` against Cloudflare R2 for file storage, and the `Job` table itself as the queue (no Redis, no BullMQ, no external queue service). All tunable behavior lives in one config file, `src/lib/config.ts`.

## 2. How To Run It

Prerequisites:

- Node.js LTS and npm installed on the machine.
- A local PostgreSQL database reachable at the `DATABASE_URL` value in `.env`.
- API keys for Google Gemini and DeepSeek, plus Cloudflare R2 credentials (endpoint, bucket, region `auto`, access key id, secret access key).

Setup:

1. `npm install` in the project root.
2. Copy `.env.example` to `.env` and fill in real values for `DATABASE_URL`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_REGION`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. Never commit the real `.env`. (`.env.example` contains only placeholders and commented-out examples; the R2 values are required at runtime and the app will refuse to start without them.)
3. Apply the Prisma schema: `npx prisma migrate dev`.
4. Seed the single test user (idempotent `upsert` on `test@local.dev`, safe to re-run): `npx prisma db seed`.

Running:

- Web app (development): `npm run dev` → http://localhost:3000. Run exactly ONE dev instance; running two against the same `.next` folder corrupts the build and produces 500s (`Cannot find module './331.js'`). To recover, stop every node dev process, delete `.next`, and start one instance again.
- Background worker: `npm run worker` (runs `tsx --env-file=.env src/worker/worker.ts` — the `--env-file=.env` flag is what loads the R2 and API-key environment variables, without it the worker fails at startup with "Missing Cloudflare R2 configuration"). Keep the worker running in a second terminal while the web app is up.
- Production-style build/check: `npm run build`, plus a strict typecheck with `npx tsc --noEmit`. Both must pass with zero errors.

## 3. The Flow, Step By Step

1. **Upload (Step 1 of the UI, `POST /api/jobs`).** The user drags in or browses receipt files. The client filters by type (`image/jpeg`, `image/png`, `application/pdf`) and size (max 10 MB each, max 5 files), and shows image previews. On submit the server re-validates *everything* server-side — file count ≤ 5 (`config.upload.maxFilesPerBatch`), each MIME type in the allowed list, each size ≤ 10 MB — because client-side validation is a convenience, not a security boundary (`config.upload.maxFileSizeMb`). The request first resolves the test user (`getTestUser`), then checks the upload rate limit (10 requests per rolling hour, FR15), then runs an ownership check (vacuous in single-user mode), then validates files. Files rejected server-side get a 400 with a specific reason; rate-limit rejection returns 429 with a `Retry-After` header.

2. **Object upload + job creation (FR3, FR4).** For each approved file the server pre-generates a job id, builds the storage key `receipts/<userId>/<jobId>-<sanitizedFileName>`, uploads the raw bytes to Cloudflare R2 via `uploadFileToStorage` (the file itself never touches the database), and **only then** inserts a `Job` row in status `pending`. The upload happens before the row insert on purpose: creating a `pending` row first let the fast-polling worker claim a job whose object was not yet in R2 and fail it. The endpoint responds `202 {"jobIds": [...]}` immediately and the UI moves to the Processing step.

3. **Processing (Step 2, worker + `GET /api/jobs`).** The extraction worker (`src/worker/worker.ts`) polls every 3 seconds for `pending` rows ordered by `createdAt` ascending (FIFO). It computes free slots from `config.concurrency.cap` (2) minus the number of in-flight jobs, then for each candidate attempts an atomic claim using `updateMany({ where: { id, status: "pending" }, data: { status: "processing" } })` — only one poller can win each row's transition, so two worker processes can never both process the same job. Claimed jobs are handed to `processJob` and tracked in an in-process counter. The Processing view polls `GET /api/jobs` every 3 seconds and shows each job's live status badge (`pending`, `processing`, `done`, `failed`) plus its attempt count and, on failure, its error message.

4. **Extraction (worker, FR5–FR8, FR7a, FR14).** `processJob` downloads the object from R2 (`getFileFromStorage`) and calls `extractExpenseData` (Gemini, temperature 0.1, maxOutputTokens 2048, 20-second timeout via `AbortController`, structured JSON output requested through Gemini's `responseMimeType: "application/json"` plus an inline `responseSchema` that mirrors the locked `ExpenseExtraction` shape). The raw model text is **never** trusted: the worker JSON-parses it and runs `ExpenseExtraction.safeParse`. Retry paths, each gated by `config.retries`:

   - Provider error (timeout, network, 5xx): one retry after a fixed 2000 ms backoff (`providerRetries: 1`).
   - Truncation (raw output isn't valid JSON): one retry with maxOutputTokens raised to 3072 (`truncationRetries: 1`, FR7a).
   - Validation failure (invalid JSON or schema violation): one corrective-prompt retry (`validationRetries: 1`) where the worker tells Gemini exactly which fields failed Zod validation.

   On success the job becomes `done` with `extraction` (the validated object), `rawOutput`, `inputTokens`, and `outputTokens` persisted. On final failure it becomes `failed` with a correctly prefixed `errorMessage` — `[provider_unavailable]` for provider/storage/timeout failures, `[invalid_output]` for validation failures — and the raw output is preserved in `rawOutput` for never-guessed, honest debugging.

5. **Result (Step 3, `GET /api/jobs/[id]`).** The Result view polls the job every 3 seconds until it hits a terminal state. A `done` job shows the validated fields — Vendor, Transaction Date, Currency, Total, Category — plus the line-items table, and shows a "Partial extraction" notice only when an independent condition holds: vendor or total is null, and/or a `confidenceNote` is present. A `failed` job shows a clear error alert derived from the `[provider_unavailable]` / `[invalid_output]` prefix and explicitly shows no partial or guessed data; the only offered recovery is re-uploading a clearer copy from Step 1 (no manual retry of a failed `Job` — that is an explicit Non-Goal).

6. **Follow-up (Step 4, `POST /api/jobs/[id]/followup`).** The user clicks "Generate summary" / "Summarize this expense" on a selected job. The route re-checks the follow-up rate limit (20 per rolling hour, FR16), looks up the job, enforces ownership (403), and requires the job to be `done` with a validated `extraction` (400 otherwise). Retriggering an already-`done` follow-up is rejected (FR12 non-retrigger rule). A `FollowUpAction` row is created in `processing` status with `attempts: 1`, and the **validated expense record** (not raw model text, not the receipt image) is sent to DeepSeek (`deepseek-chat`, temperature 0.4, max 200 output tokens, 15-second timeout, `response_format: json_object`). The follow-up call is bounded by an in-process semaphore (cap `followupCap: 2`) and follows the same honesty rules as the worker: one provider retry, then a corrective summary retry if the JSON fails `ExpenseSummary.safeParse`; a final failure is recorded with a prefixed `errorMessage` and the raw output preserved. `GET /api/jobs/[id]/followup` returns the latest follow-up state; the UI shows the validated summary once `done`, or a "Try again" button when `failed` (retry-after-failure is supported; retrigger-after-success is not).

## 4. The Data Model

Prisma schema (`prisma/schema.prisma`) against PostgreSQL, four tables, two enums:

- **`User`** — `id` (cuid PK), `email` (unique), `createdAt`. Exactly one row is created by the idempotent seed (`upsert` on `test@local.dev`). No password, no session, no auth.
- **`Job`** — `id` (cuid PK), `userId` FK → `User`, `status` (enum `JobStatus`: `pending`/`processing`/`done`/`failed`, default `pending`), `storageKey` (the R2 object key — the file itself is never stored in the DB), `fileName`, `mimeType`, `attempts` (default 0), `errorMessage?`, `rawOutput?`, `extraction` (JSONB), `inputTokens?`, `outputTokens?`, `createdAt`, `updatedAt`. Index `(userId, createdAt)`.
- **`FollowUpAction`** — `id` (cuid PK), `jobId` FK → `Job`, `status` (same `JobStatus` enum), `attempts`, `errorMessage?`, `rawOutput?`, `summary?`, `inputTokens?`, `outputTokens?`, `createdAt`, `updatedAt`. Index `(jobId, createdAt)`.
- **`RateLimitEvent`** — `id` (cuid PK), `userId` FK → `User`, `endpoint` (enum `RateLimitEndpoint`: `upload`/`followup`), `createdAt`. Index `(userId, endpoint, createdAt)` — this is the column layout that makes the sliding-window count fast. Events older than 2 hours (`config.rateLimitRetentionHours`) are deleted during rate-limit checks.

Which database constraints make invalid states impossible:

- Primary keys on every table: a job / follow-up action / rate-limit event / user id is unique and never null.
- `User.email` is **UNIQUE**: the seeded test user can only ever exist once, and the seed's `upsert` is the only creator.
- Foreign keys with `ON DELETE RESTRICT`: a `Job` always points at an existing `User`; a `FollowUpAction` always points at an existing `Job`; a `RateLimitEvent` always points at an existing `User`. Orphan rows are impossible.
- Enum types for `status` and `endpoint`: the database itself rejects any status other than `pending/processing/done/failed` and any endpoint other than `upload/followup`.
- `NOT NULL` on `storageKey`, `fileName`, `mimeType`: every job knows exactly which object in storage it represents — enforced at the schema level, matching the "never store the file in the DB" rule.
- What the DB deliberately does *not* enforce: legal status transitions (e.g. `done` implies `extraction` non-null, `failed` implies a prefixed `errorMessage`). Those are invariants enforced by the application code (worker and follow-up route) and recorded, not by constraints — the schema is exactly as specified and kept minimal on purpose.

## 5. The Concepts

### 5.1 The background job model

- **What it is:** Every upload becomes a row in the `Job` table with a lifecycle (`pending → processing → done | failed`). Work is performed by a standalone Node process (`src/worker/worker.ts`) that runs *alongside* the Next.js app, not inside an HTTP handler.
- **Why it is needed:** Provider calls are slow (seconds) and may fail. If the request handler waited on Gemini, the upload would block, time out from the client's perspective, and give the user no honest progress. An async job lets the API return immediately (202) and gives the UI a real status to display.
- **How I implemented it:** `POST /api/jobs` creates rows and returns `{ jobIds }` with status 202 without making a single provider call. The worker polls the table every 3 s, claims rows, processes them, and writes terminal state plus token usage back. The UI polls `GET /api/jobs` and `GET /api/jobs/[id]` every 3 s and stops when a job reaches `done`/`failed`.
- **What I chose against:** Running provider calls in the request handler (blocking, no honest status, FR4 violation — explicitly forbidden in AGENTS.md rule 10), and converting the whole thing into a serverless function per job (the PRD locks a single long-running worker process).

### 5.2 The `Job` table as the queue

- **What it is:** There is no separate queue technology — the relational `Job` table *is* the queue. New work arrives as `pending` rows; active work is `processing`; finished work stays in the same table as the durable record.
- **Why it is needed:** A background worker needs somewhere to discover work, and the work's state must survive a worker crash. Using the same PostgreSQL table that already tracks jobs means the queue cannot get out of sync with the jobs, and it satisfies the PRD's explicit choice of "no external queue service".
- **How I implemented it:** Every 3 s the worker does `findMany({ where: { status: "pending" }, orderBy: { createdAt: "asc" }, take: <freeSlots> })` — FIFO by submission time — then claims each one atomically (see 5.3).
- **What I chose against:** Redis, BullMQ, and SQS (all explicitly out of scope in AGENTS.md §2), and separate "queue table" + "job table" designs that would let a job and its queue entry disagree.

### 5.3 Atomic claim + concurrency cap

- **What it is:** A job must be claimed by exactly one worker at a time, and a single worker must never exceed `config.concurrency.cap` in-flight provider calls. The claim happens at the database level, not in application memory.
- **Why it is needed:** With a polling worker, the read-then-update pattern has a classic race: two polls from two processes (or two tick intervals) could both read the same `pending` row and both send it to Gemini, double-charging the provider and corrupting attempt counts.
- **How I implemented it:** The worker claims via `prisma.job.updateMany({ where: { id, status: "pending" }, data: { status: "processing" } })` and only starts work when `claimed.count > 0`. Because `status` is in the `WHERE`, only one claimant can win the transition to `processing`. In-flight work is tracked by an in-process counter `activeJobsCount`, and the worker only ever takes up to `cap - activeJobsCount` (2) rows per poll. The follow-up path uses the same idea via an in-process semaphore (`src/lib/concurrency.ts`, `withConcurrencyLimit`, cap 2) around the DeepSeek call.
- **What I chose against:** A literal `SELECT ... FOR UPDATE SKIP LOCKED` statement (AGENTS.md allows "a SKIP LOCKED-style pattern"; the guarded `updateMany` gives the same exactly-once guarantee in plain Prisma), and in-memory locks shared across processes (they wouldn't survive a second worker).

### 5.4 Stuck-job recovery (the sweep)

- **What it is:** The worker, running alone, is a single point of failure mid-call. If it crashes while a job sits in `processing`, that job would be stuck forever. A periodic sweep detects and recovers it.
- **Why it is needed:** At-most-once would silently lose user work; at-least-once needs a "crashed" detector. The rule is locked by AGENTS.md §2: 60 s with no update means crashed mid-call, the job gets exactly one re-attempt, then fails.
- **How I implemented it:** Every 30 s, `sweepStuckJobs` finds `status: "processing"` rows whose `updatedAt` is older than `config.worker.stuckJobTimeoutMs` (60 s). If `attempts < 2` it resets the row to `pending` for one more poll-cycle attempt; otherwise it marks it `failed` with `[provider_unavailable] Job timed out in processing state after 60 seconds`. Because the claim increments naturally into `attempts`, the "one re-attempt" budget is exactly one reset-then-fail cycle.
- **What I chose against:** Letting jobs hang forever, or auto-retrying more than the locked single re-attempt, and an external process supervisor instead of the DB-tracked sweep.

### 5.5 Structured output enforcement (Zod)

- **What it is:** No model output is ever persisted or shown without first passing its Zod schema. Gemini outputs are validated against `ExpenseExtraction`; DeepSeek outputs against `ExpenseSummary`. The schema *also* mirrors the provider's own structured-output configuration, but the provider's compliance is never trusted on its own (FR6, FR14).
- **Why it is needed:** LLMs produce plausible-looking garbage. Without an enforced schema, a null-vs-guess violation, a future date, a 3-letter-currency violation, or an out-of-enum category could reach the database and the UI. The `confidenceNote` rule ("only when something was null or category is `uncategorized`") can only be enforced at the schema/app level.
- **How I implemented it:** Define `ExpenseExtraction` (`vendor?`, `transactionDate` (`.date()`), `currency` (`.length(3)`), `total` (`.nonnegative()`), `category` enum of 8 values, `lineItems` max 50, `confidenceNote` max 280) and `ExpenseSummary` (`summary` 1–500 chars) in `src/lib/ai/schemas.ts`; JSON-parse the raw model output; `safeParse`; only persist the parsed data on success. On final validation failure, store `rawOutput` plus a `[invalid_output]` error listing the exact Zod issue paths so the problem is reproducible.
- **What I chose against:** Persisting `response.text` directly, trusting the provider's JSON mode alone, or adding a second validation library (Zod is locked).

### 5.6 The extractor's safety rules (prompt + null-guessing)

- **What it is:** The extractor must "extract only what is visibly present," leaving fields `null` rather than guessing, with one exception: `category` always resolves to a real value from the fixed list (`uncategorized` only when nothing fits). `confidenceNote` is populated only under the exact trigger conditions (FR7 and the locked system prompt).
- **Why it is needed:** An expense record with invented vendor/amounts is worse than one with honest `null`s, and the whole "partial extraction notice" UX depends on the model refusing to guess.
- **How I implemented it:** The prompt lives verbatim in `src/lib/ai/prompts.ts` (`EXTRACTOR_SYSTEM_PROMPT`), the schema allows nullable fields, the result view independently recomputes "partial extraction" from actual non-null data, and a `done` job's `confidenceNote` is shown to the reviewer. No application-layer heuristic ever fills a null field.
- **What I chose against:** Post-processing to infer missing values in code, and loosening the prompt to make extraction "more useful."

### 5.7 Retries, token caps, timeouts, and temperature

- **What it is:** Every provider call has locked `temperature`, `maxOutputTokens`, and timeout values: extractor 0.1 / 2048 (3072 on the truncation retry) / 20 s; follow-up 0.4 / 200 / 15 s. `topP` is deliberately unset.
- **Why it is needed:** Deterministic extraction quality (low temperature), capped response size (predictable cost and bounded UI data), and a hard timeout so a hung provider can't hang the worker or the follow-up request forever. Every value maps to a PRD number (FR6, FR7a, Section 6 model-parameter table).
- **How I implemented it:** All values live in `src/lib/config.ts` (temperature, tokenCaps, timeouts) and are passed per call; timeouts are enforced via `AbortController` wired into the SDK calls (Gemini `abortSignal`, OpenAI request signal); truncation is detected as "raw output isn't valid JSON" and retried at 3072 exactly once.
- **What I chose against:** Tuning temperatures or raising caps to chase quality, adding a `topP`, and skipping the truncation-retry path to cut complexity.

### 5.8 Sliding-window rate limiting

- **What it is:** A Postgres-backed sliding-window limiter, one table `RateLimitEvent` with rows per user+endpoint+timestamp (FR15, FR16). No Redis, no external rate-limit service.
- **Why it is needed:** The whole point of the slice is demonstrating honest cost control: provider spend must be capped at the source, and a user hammering upload or follow-up must be politely blocked with a real `Retry-After`.
- **How I implemented it:** `checkRateLimit` computes a 1-hour window (`config.rateLimitWindowMs`), deletes events older than 2 h (`rateLimitRetentionHours`), counts events in the window per endpoint, and returns `allowed:false` with `Retry-After` computed from the oldest event's expiry when `count >= max` (10 uploads/hr, 20 follow-ups/hr). The route returns `429` + `Retry-After` header. Events are recorded only after a request passes validation (upload) / passes pre-checks (follow-up), so a rejected request doesn't consume quota.
- **What I chose against:** Redis counters (locked against external services), in-memory-only counters (lost on restart), and a fixed-hour clock window (a user could exploit bucket edges; sliding is fairer).

### 5.9 Honest failure recording and error prefixes

- **What it is:** A failure is never hidden, swallowed, or silently retried without a record (AGENTS.md rule 6). Provider failures and validation failures are distinguishable by an exact prefix.
- **Why it is needed:** A user must never see a job silently disappear or a generic error; and an ops reader must be able to tell at a glance whether a failure was infrastructure (`[provider_unavailable]`) or output quality (`[invalid_output]`). The two demand different responses (resend/retry vs. better prompt).
- **How I implemented it:** Every terminal failure path writes `errorMessage` with the correct prefix plus detail; `rawOutput` is preserved on validation failures; the result/follow-up views render the message verbatim and only offer the appropriate recovery (re-upload, or "Try again" for a follow-up). The sweep, storage-read failure, and provider timeouts all land in `[provider_unavailable]`; only Zod-final-failure lands in `[invalid_output]`.
- **What I chose against:** Logging-and-continuing, generic "something went wrong" strings, and silently retrying without bumping `attempts`.

### 5.10 Object storage "file never in the DB" + test-user bootstrapping

- **What it is:** Uploaded files live in object storage (initially MinIO in dev; this deployment now uses **Cloudflare R2** via `@aws-sdk/client-s3`, per explicit user direction with the MinIO fallback removed). Only the object key — `receipts/<userId>/<jobId>-<fileName>` — is stored in `Job.storageKey`. And there is no login: a single `User` row is created once by an idempotent seed.
- **Why it is needed:** Storing binary blobs in Postgres bloats the DB and slows every query; R2 is the locked S3-compatible choice; and the PRD explicitly prohibits auth in this version, so "the current user" is always the one seeded test user.
- **How I implemented it:** `FETCH`/`multipart` upload → `uploadFileToStorage`/`getFileFromStorage`/`generateStorageKey` in `src/lib/storage/s3.ts`, with all R2 config read from env vars (requireEnv throws a clear error listing the missing variable — that's why the worker script must load `.env`). The seed is `prisma.user.upsert({ where: { email: config.testUser.email }, update: {} , create: { email } })`, and `getTestUser` resolves every request to that one row, throwing with seed instructions if it's missing.
- **What I chose against:** Base64-in-DB storage; keeping MinIO/its fallbacks for production after the R2 decision; and building any login/signup/password/session stub "for completeness" (explicit scope creep).

## 6. What Went Wrong

- **Corrupted `.next` build → intermittent 500s on `GET /api/jobs`.** During local development the app started returning `Cannot find module './331.js'` / `MODULE_NOT_FOUND`, and `routes-manifest.json` was found truncated, so only some routes compiled. The cause was **multiple concurrent Next.js dev processes** (a stale background dev server plus a freshly started one) writing to the same `.next` folder on Windows, racing each other's file writes. Fix: identify and kill *every* node dev process, delete `.next` entirely, and run exactly one `npm run dev`. Recovery was verified by restarting clean and polling `/` and `/api/jobs` back to 200. The durable rule now: one dev instance at a time; never restart one dev while another is alive.

- **Worker crashed at startup: "Missing Cloudflare R2 configuration".** `npm run worker` ran `tsx src/worker/worker.ts`, and `tsx` does not load `.env` by default, so `R2_ENDPOINT` and friends were absent, and `s3.ts`'s `requireEnv` threw immediately. This is also the historical root of the earlier "R2 regression" scare — the storage code and routes were byte-identical; the worker simply had no environment. Fix: `package.json` worker script became `tsx --env-file=.env src/worker/worker.ts`; verified by starting the worker and confirming R2 config vars were present (digests matched, values never printed). Side lesson: `.env.example` documents the exact variable names so this is reproducible-safe.

- **A "pending row before the object exists" race in upload.** An earlier upload approach created the `Job` row as `pending` first, then uploaded to R2. The 3-second worker could claim the row while the object wasn't in the bucket yet and fail the job with "the specified key does not exist" — a false failure caused purely by ordering. Fix: in `POST /api/jobs`, pre-generate the `jobId`, build the storage key from it, upload the object, and only then insert the `pending` row (see the explanatory comment in `route.ts:83-87` and the corresponding sweep/claim logic that makes it safe).

- **Retry thresholds started as bare literals and drifted from the single config file.** An audit of the retry paths found the sweep used a raw `attempts < 2` and retry gates were written inline, while AGENTS.md mandates all tunables live in `src/lib/config.ts`. Fix: the worker and follow-up retry gates now compute from `config.retries.*` (`providerRetries`, `truncationRetries`, `validationRetries`, `providerBackoffMs`), and the sweep's one-re-attempt budget is expressed against `config.worker.stuckJobTimeoutMs` with its locked meaning documented. (The `attempts < 2` budget in the sweep itself is the *mandated* locked rule, kept deliberately.)

- **The follow-up used to be one untuned prompt with drift risk.** The `FOLLOWUP_SYSTEM_PROMPT` and the DeepSeek call had to be re-specified so the summary is never under-length or hallucinated: it must be 2–4 sentences, strictly under 500 characters, synthesized from the validated extraction only, must never invent vendor/amount/date/category/line items, and must acknowledge null vendor or other fields rather than guessing. Fix: locked prompt text lives in `src/lib/ai/prompts.ts`; the DeepSeek `max_tokens` and JSON output format come from config; validation of the returned summary is unchanged (`ExpenseSummary.safeParse`). Typecheck and build stay clean.

## 7. What This Slice Does Not Handle

- **No authentication or multi-tenancy of any kind.** There is no login screen, signup, password, session, or credential check. Every request acts as the single seeded test user `test@local.dev`. This is an explicit scope decision (FR0.1, Section 3 Non-Goals), correct for a local/assessment slice and *not* safe for internet deployment.
- **No serverless or distributed queueing.** The `Job` table plus one long-running worker process is the whole concurrency story; a second worker replica is not load-balanced, and each process has its own in-process cap.
- **No multi-provider fallback.** If Gemini (extractor) or DeepSeek (follow-up) fails, the job fails with `[provider_unavailable]` after its bounded retries; there is deliberately no automatic fallback to another provider.
- **No editing, sharing, exporting, deleting, manual retry of failed jobs, multi-currency conversion, tax computation, accounting/ERP integration, or admin dashboard beyond the raw job table.** Each is an explicit Non-Goal (Section 3). The only recovery for a failed extraction is a new upload; the only follow-up action is "Summarize this expense", and it cannot be re-triggered after success.
- **No persistent document retention strategy** beyond the R2 bucket (objects are written, never cleaned up by the app), and no multi-page application structure — the UI is the one 4-step wizard page.
- **No live-cost accounting.** Token usage (`inputTokens`/`outputTokens`) is recorded per job, but the slice performs no pricing math or billing; cost control is enforced by the engineering-side caps (rate limits, concurrency, token caps, timeouts, bounded retries) rather than after-the-fact billing.
- **Files are stored in R2 by design**, so the app depends on that bucket's availability for the worker to read objects back.

## 8. If I Built This Again

I would keep the same skeleton — a relational `Job` table as the queue, a single long-running worker polling it with atomic claims, every provider call validated through Zod before it can be persisted or shown, per-endpoint DB rate limiting, and all tunables centralized in one config file — because that combination produced a system where every failure has a visible, correctly-prefixed cause, spend is capped at the source, and there is no hidden state; but I would build the follow-up action into the worker's dispatch path from day one instead of letting it run inside the web process (the current route executes DeepSeek inline under a semaphore, which works for this single-user slice but is the least clean part of the design), I would add the `SKIP LOCKED`-literal Prisma query or a dedicated claim-and-return pattern from the start rather than arriving at the guarded `updateMany` during the race audit, and I would enforce the "one dev process" rule with a small startup script instead of learning it from a corrupted `.next` folder.

---

## Evidence

Screenshots captured during local testing live in `docs/images/` and are referenced by their exact relative paths:

| Path | What it evidences |
|---|---|
| `docs/images/01-jobs-table-success-and-failure.png` | The `Job` table showing both a `done` extraction (validated result + token usage) and a `failed` job with its prefixed `errorMessage` — the honest-jobs-table requirement. |
| `docs/images/02-raw-output-and-validated-result.png` | The persisted `rawOutput` next to the validated `extraction` — showing the raw model text is kept but only the Zod-validated object is used. |
| `docs/images/03-validation-failure-ui.png` | The failed-validation UI — the `[invalid_output]` error shown to the user with no guessed/partial data (primary validation-failure evidence). |
| `docs/images/03-validation-failure-ui.-1.png` | An additional example of the same validation-failure behavior — not a separate assessment requirement. |
| `docs/images/04-concurrency-cap-2.png` | Evidence of the worker processing at most 2 jobs concurrently (the `config.concurrency.cap` of 2 in practice). |
| `docs/images/05-database-storage-key-only.png` | The `Job` table storing only the `storageKey` — no binary file data anywhere in the database. |

Each of the six paths above was verified to exist on disk. The screenshots themselves cannot be textually read by the documentation tooling, so their on-disk presence and names are confirmed, but their pixel contents should be verified by opening them.