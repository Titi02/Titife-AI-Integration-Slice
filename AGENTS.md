# AGENTS.md — The AI Integration Slice

This file governs how an AI coding agent (running in Antigravity) behaves while
building this project. It does not describe features — that is the PRD's job.
This file describes conduct: what is locked, what must never happen, how work
is arranged, how code must look, what "done" means, and what to do when
unsure. If anything here conflicts with a feature request, this file wins.

---

## 1. What is this project

**The AI Integration Slice** is a single-flow web application. A user uploads
one or more receipt images or PDFs; a background job sends each file to
Gemini for structured expense-data extraction; the user can optionally
trigger one follow-up action ("Summarize this expense") powered by DeepSeek.
The point of this project is to demonstrate a *correct* AI integration —
async processing, structured output with schema validation, honest job
tracking, rate limiting, and graceful failure handling — not to build a real
expense-management product.

- **Audience:** a single seeded test user. There is no real user base.
- **Version being built:** Revision 5 of the PRD — no login flow of any
  kind, single seeded test user, fully independent of any other project
  ("Assessment 1").
- **Source of truth:** the PRD document (`AI_Integration_Slice_PRD_Revision5`)
  is the source of truth for *what* to build, feature by feature, phase by
  phase. This file is the source of truth for *how* to build it. When the
  PRD gives a specific number, name, or schema, use it exactly — do not
  interpolate, round, or "improve" it.
- Every rule below cites its PRD section or FR number where one exists, so
  you can trace it back to the requirement it enforces.

---

## 2. What is locked

The following are already decided. Do not change, swap, replace, upgrade,
"modernize," or add alternatives to any of them, even if you believe another
choice is objectively better. If you think a locked choice is wrong, say so
in a comment and stop — do not silently substitute your own judgment.

### Stack
- **Framework:** Next.js, with TypeScript throughout. No JavaScript files.
- **ORM / schema:** Prisma, against PostgreSQL. No other ORM, no raw SQL
  query builder, no switching databases.
- **Validation:** Zod, for every structured input and every model output.
  No other validation library.

### AI providers — routed by role, not swappable (Section 6)
- **Extractor role:** Gemini (`gemini-3.6-flash`), called via the official
  `@google/genai` SDK. Do not call Gemini's REST API directly and do not
  substitute another vision model for this role.
- **Follow-up role:** DeepSeek (`deepseek-chat`), called via the official
  `openai` SDK pointed at DeepSeek's OpenAI-compatible base URL
  (`https://api.deepseek.com`). This substitution is intentional and
  documented — do not "fix" it by installing a DeepSeek-specific package or
  switching the follow-up role to Gemini.
- Do not add a third provider, and do not add automatic fallback from one
  provider to another — this is explicitly out of scope (Section 9, Open
  Questions).

### File storage (Section 7)
- S3-compatible object storage. MinIO in local development, S3 in
  production, both accessed through the official `@aws-sdk/client-s3` SDK.
  Do not use local disk storage for uploaded files and do not use a
  different storage SDK.

### Background processing (Section 6, "Jobs and Workers")
- A single Node worker process (`worker.ts`) runs **alongside** the Next.js
  app, not inside an API route, not as a serverless function per job.
- The worker polls the `Job` table every 3 seconds for `pending` rows,
  ordered by `createdAt` ascending (FIFO).
- Claiming must use a `SELECT ... FOR UPDATE SKIP LOCKED`-style pattern so
  multiple worker instances never double-process the same job.
- No external queue service (no BullMQ, no Redis queue, no SQS). The `Job`
  table itself is the queue.
- If a job sits in `processing` for more than 60 seconds with no update
  (a crashed worker mid-call), a sweep resets it to `pending` for exactly
  one re-attempt, then `failed` if it happens again. Do not change this
  60-second threshold or the one-re-attempt limit without it being asked
  for explicitly.

### Rate limiting (Section 7)
- Implemented as a Postgres-backed sliding-window table (`RateLimitEvent`),
  not Redis, not an external rate-limiting service.

### Authentication — deliberately absent (Section 3, Section 5 FR0.1,
Section 7 "Test User Bootstrapping")
- There is **no** login screen, signup flow, password, session token,
  cookie, or credential check of any kind in this version.
- A single `User` row is created once by an **idempotent** Prisma seed
  script (`upsert` on a fixed email — never a plain `create`, which would
  fail on every re-run after the first).
- Every request resolves "the current user" by looking up this one seeded
  row. Do not build a login UI, a signup form, or a password field, even as
  a stub, even if it seems more "complete." Adding any of this is scope
  creep, not an improvement.

### Data model (Section 10)
The Prisma schema below is locked. Field names, types, relations, enum
values, and indexes must match exactly. Do not add fields "for
flexibility," do not rename fields to match a different convention, and do
not drop the listed indexes.

```prisma
model User {
  id            String    @id @default(cuid())
  email         String    @unique
  createdAt     DateTime  @default(now())
  jobs          Job[]
  rateLimits    RateLimitEvent[]
}

model Job {
  id            String        @id @default(cuid())
  userId        String
  user          User          @relation(fields: [userId], references: [id])
  status        JobStatus     @default(pending)
  storageKey    String
  fileName      String
  mimeType      String
  attempts      Int           @default(0)
  errorMessage  String?
  rawOutput     String?
  extraction    Json?
  inputTokens   Int?
  outputTokens  Int?
  createdAt     DateTime      @default(now())
  updatedAt     DateTime      @updatedAt
  followUp      FollowUpAction[]

  @@index([userId, createdAt])
}

enum JobStatus {
  pending
  processing
  done
  failed
}

enum RateLimitEndpoint {
  upload
  followup
}

model FollowUpAction {
  id            String            @id @default(cuid())
  jobId         String
  job           Job               @relation(fields: [jobId], references: [id])
  status        JobStatus         @default(pending)
  attempts      Int               @default(0)
  errorMessage  String?
  rawOutput     String?
  summary       String?
  inputTokens   Int?
  outputTokens  Int?
  createdAt     DateTime          @default(now())
  updatedAt     DateTime          @updatedAt

  @@index([jobId, createdAt])
}

model RateLimitEvent {
  id          String              @id @default(cuid())
  userId      String
  user        User                @relation(fields: [userId], references: [id])
  endpoint    RateLimitEndpoint
  createdAt   DateTime            @default(now())

  @@index([userId, endpoint, createdAt])
}
```

### Structured output schemas (Section 6) — locked shape
```typescript
const ExpenseExtraction = z.object({
  vendor: z.string().min(1).nullable(),
  transactionDate: z.string().date().nullable(),
  currency: z.string().length(3).nullable(),
  total: z.number().nonnegative().nullable(),
  category: z.enum([
    "meals", "travel", "office_supplies", "software",
    "lodging", "transport", "uncategorized", "other"
  ]),
  lineItems: z.array(z.object({
    description: z.string(),
    amount: z.number().nonnegative(),
  })).max(50),
  confidenceNote: z.string().max(280).nullable(),
});

const ExpenseSummary = z.object({
  summary: z.string().min(1).max(500),
});
```

### Model parameters — locked values, do not tune (Section 6)
| Role | temperature | maxOutputTokens | timeout |
|---|---|---|---|
| Extractor (Gemini) | 0.1 | 2048 (retry at 3072 on truncation only, FR7a) | 20s |
| Follow-up (DeepSeek) | 0.4 | 200 | 15s |

`topP` is deliberately left unset for the extractor — do not add a `topP`
value; the PRD explicitly rejected one as unjustified.

### System prompt — locked wording (Section 6)
Use this instruction verbatim for the extractor role. Do not paraphrase it,
shorten it, or "clean it up" — every clause in it maps to a specific
functional requirement (the null-vs-guess rule, the category exception, the
confidenceNote trigger condition):

> "Extract only what is visibly present. Leave a field null rather than
> guess, except for category, where you must select the closest match from
> the fixed list, using 'uncategorized' only when no category is a
> reasonable fit. Populate confidenceNote only when at least one field was
> left null due to illegibility, or when category was set to
> 'uncategorized'; otherwise leave confidenceNote null. Keep confidenceNote
> under 280 characters and reference only the specific fields affected."

### Configuration — locked shape and values (Section 7)
Every changeable value lives in one config file. Do not scatter magic
numbers through the codebase, and do not add a new config system:

```typescript
export const config = {
  testUser: { email: "test@local.dev" },
  models: {
    extractor: { provider: "gemini", model: "gemini-3.6-flash" },
    followup: { provider: "deepseek", model: "deepseek-chat" },
  },
  timeouts: { extractorMs: 20000, followupMs: 15000 },
  tokenCaps: {
    extractorMaxOutput: 2048,
    extractorTruncationRetryMaxOutput: 3072,
    followupMaxOutput: 200,
  },
  temperature: { extractor: 0.1, followup: 0.4 },
  rateLimits: { uploadsPerHour: 10, followupsPerHour: 20 },
  concurrency: { cap: 2 },
  retries: { validationRetries: 1, providerRetries: 1, truncationRetries: 1 },
  rateLimitRetentionHours: 2,
  upload: {
    maxFileSizeMb: 10,
    maxFilesPerBatch: 5,
    allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
  },
};
```

---

## 3. What must never happen

Every rule below is a business or user-protection rule. **Breaking any rule
on this list means the task has failed, even if the code compiles, the
tests pass, and the feature appears to work.** These are not style
preferences — they protect data isolation, cost control, and user trust.

1. **Never let money or provider spend go uncapped.** Every provider call
   must go through the configured rate limits (FR15, FR16), token caps, and
   the concurrency cap of 2 (FR9). Never remove, raise, or bypass these to
   "make a test pass" or "make it feel faster." (Section 8)

2. **Never touch, import, require, migrate, query, or connect to any other
   project's database, credentials, `.env`, or codebase — under any name,
   including "Assessment 1" or "AuthSlice."** This project has its own
   dedicated PostgreSQL database, its own dedicated credential, its own
   Prisma schema and migration history, starting from empty. No shared
   `.env` values, no shared connection strings, no runtime import of another
   project's code, ever. (Section 7, "Database and Environment Isolation")

3. **Never build a login screen, signup form, password field, session
   cookie, or any credential check.** This is not an oversight to fix — it
   is an explicit, documented scope decision (Section 3 Non-Goals, Section
   5 FR0.1). The single seeded test user is created once by an idempotent
   seed script and nothing else. If you think auth is missing, it isn't —
   check Section 9's Risks entry before "fixing" this.

4. **Never store an uploaded file in the database.** Only the object
   storage key goes in `Job.storageKey`. The file itself lives in object
   storage (MinIO/S3) and nowhere else. (FR3, Section 7 "File Storage")

5. **Never let the model's raw output reach the UI or the database
   unvalidated.** Every extractor and follow-up response must pass through
   its Zod schema (`ExpenseExtraction` / `ExpenseSummary`) before it is
   persisted or shown. The provider's own structured-output compliance is
   never treated as sufficient on its own. (FR6, FR14, Section 6
   "Structured Output Enforcement")

6. **Never hide, swallow, or silently retry a failure without recording
   it.** Every failed `Job` and every failed `FollowUpAction` must end with
   a real, human-readable `errorMessage`, correctly prefixed
   (`[provider_unavailable]` or `[invalid_output]`, FR8a), and the raw model
   output preserved in `rawOutput` on a validation failure (FR7). A user
   must never see a job silently disappear or a generic, uninformative
   error.

7. **Never let the extractor guess a value it cannot see**, except for the
   one documented exception: `category` must always resolve to a real value
   (including `"uncategorized"`), every other field must be left `null`
   rather than guessed. This is enforced by the system prompt and must not
   be "corrected" in application code by inferring values the model left
   null.

8. **Never build features outside this slice's one flow.** No editing,
   sharing, exporting, or deleting of results; no multi-currency conversion,
   tax computation, or accounting integration; no mobile app; no admin
   dashboard beyond the raw jobs table; no manual retry of a failed `Job`
   (the user re-uploads instead, FR13a vs. the Job non-retry Non-Goal); no
   second follow-up action type beyond "Summarize this expense" (FR12); no
   multi-provider fallback (Section 9 Risks / Open Questions). These are
   explicit Non-Goals (Section 3) — building any of them "while you're in
   there" is scope creep and counts as a failed task even if the extra
   feature works.

9. **Never deploy or configure this application for multi-user or
   internet-facing use as it currently stands.** There is no access control
   of any kind; every request is treated as the one seeded user. This is
   only acceptable for local/assessment use (Section 9, Risks — "No access
   control exists"). Do not add public hosting configuration, do not remove
   this limitation quietly by inventing a lightweight auth shim — flag it
   and stop instead (see Section 7 of this file).

10. **Never run a provider call synchronously inside an HTTP request
    handler.** `POST /api/jobs` must create `Job` rows and return
    immediately (FR4); the actual Gemini/DeepSeek calls happen only in the
    background worker. If a request handler is waiting on a Gemini or
    DeepSeek response, that is a failure regardless of whether the response
    is eventually correct.

11. **Never treat client-side file validation as sufficient.** Type and size
    checks must be re-run server-side before anything is written to
    storage, every time, regardless of what the client already checked.
    (FR2 — "Client-side validation is a convenience only, not a security
    boundary.")

---

## 4. How is the work arranged

Follow this folder layout. Business logic (AI calls, schema validation,
retry logic, rate limiting) lives in `/src/lib`, never inline inside a route
handler or a React component. The worker is a separate entry point from the
web app, not a route.

```
.
├── prisma/
│   ├── schema.prisma          # the locked schema from Section 2 — do not diverge
│   ├── seed.ts                # idempotent (upsert) test-user seed script
│   └── migrations/
├── src/
│   ├── app/
│   │   └── api/
│   │       └── jobs/
│   │           ├── route.ts              # POST (upload), GET (list)
│   │           └── [id]/
│   │               ├── route.ts          # GET job status/result
│   │               └── followup/
│   │                   └── route.ts      # POST (trigger), GET (status/result)
│   │   └── (routes for the upload view, processing view, result view — UI only)
│   ├── components/            # presentational only — no Gemini/DeepSeek/Prisma calls here
│   ├── lib/
│   │   ├── ai/
│   │   │   ├── gemini.ts      # @google/genai client + extractor call
│   │   │   ├── deepseek.ts    # openai SDK client pointed at DeepSeek + follow-up call
│   │   │   ├── prompts.ts     # exact locked system prompt text lives here, nowhere else
│   │   │   └── schemas.ts     # ExpenseExtraction, ExpenseSummary (Zod)
│   │   ├── db/
│   │   │   └── prisma.ts      # single shared Prisma client instance
│   │   ├── testUser.ts        # resolves the one seeded user — the ONLY "auth" that exists
│   │   ├── storage/
│   │   │   └── s3.ts          # MinIO/S3 client, upload + key generation
│   │   ├── rateLimit.ts       # RateLimitEvent read/write + retention cleanup
│   │   └── config.ts          # the one locked config object from Section 2
│   └── worker/
│       └── worker.ts          # standalone process: polling loop, claim, dispatch, retries
├── .env.example                # this project's DATABASE_URL only — nothing else
├── package.json
└── AGENTS.md                   # this file
```

Rules about this layout:
- A route handler's job is to: resolve the test user → check rate limit →
  check ownership → call into `/lib` → return a response. It should not
  contain retry logic, provider SDK calls, or Zod schemas inline.
- The worker imports from `/lib/ai`, `/lib/db`, `/lib/storage` — the same
  modules the API routes use — so extraction logic is written once, not
  duplicated between the request path and the worker path.
- Nothing under `/lib` may import from `/app` or `/components`. Dependency
  direction is one-way: UI and routes depend on `/lib`, never the reverse.

---

## 5. How should the code look

- **Language:** TypeScript in strict mode. No `any` without a comment
  explaining why it's unavoidable. No implicit `any`.
- **Runtime:** current Node.js LTS. Use modern syntax the LTS release
  supports (ES modules, `async`/`await`, optional chaining, nullish
  coalescing) — no callback-style code, no unnecessary polyfills.
- **Tooling:** ESLint + Prettier, run clean before anything is considered
  finished. No disabling lint rules to make a build pass — fix the code
  instead, or explain in a comment why the rule genuinely doesn't apply
  here.
- **Naming:** match the PRD's own vocabulary. A `Job`, a `FollowUpAction`, a
  `RateLimitEvent`, an `ExpenseExtraction`, an `ExpenseSummary` — use those
  exact nouns in code, not renamed synonyms like `Task`, `Receipt`, or
  `Result`. This keeps code and spec traceable to each other.
- **Error handling:** never swallow an error silently (`catch {}` is not
  acceptable anywhere in this codebase). Every catch block either updates a
  `Job`/`FollowUpAction` row with a real error message, or re-throws with
  added context. This is not a style nicety — it is required by rule 6 in
  Section 3.
- **Comments:** explain *why*, not *what*, especially next to every locked
  parameter (temperature, token caps, timeouts) — carry forward the PRD's
  one-line justification as a code comment so a future reader doesn't
  "helpfully" retune it.
- **No premature abstraction.** This is a single, small flow. Don't build a
  generic plugin system for "future providers" or a generic job-queue
  abstraction beyond what FR5–FR9 actually require. Build exactly what the
  PRD specifies, cleanly, and stop.
- **No dead code, no commented-out blocks, no speculative feature flags**
  for phases that haven't been reached yet (see Section 6, Phased Roadmap —
  build phase by phase, not all at once).

---

## 6. What counts as done

Before considering any phase of work complete, verify all of the following.
**The project must build with zero errors and zero type errors.** A
feature that "works" in the browser but fails `tsc`, `next build`, or lint
is not done.

- [ ] `npm run build` (or equivalent) completes with zero errors.
- [ ] `npx tsc --noEmit` reports zero type errors.
- [ ] ESLint reports zero errors (warnings reviewed, not silently ignored).
- [ ] `npx prisma migrate dev` runs clean against a fresh, empty database
      using only this project's own `.env` — no Assessment 1 files present.
- [ ] The idempotent seed script (`upsert`) can be run twice in a row
      without error or duplicate rows.
- [ ] Upload endpoint (FR1–FR4): rejects wrong file type/size server-side,
      creates `Job` rows, returns immediately without waiting on the model.
- [ ] Worker (FR5–FR9): polls, claims up to `CONCURRENCY_CAP` (2) jobs at a
      time using `SKIP LOCKED`, never exceeds that concurrency regardless of
      queue depth.
- [ ] Validation failure path (FR7, FR7a) and provider-error path (FR8, FR8a)
      both produce a correctly prefixed `errorMessage` and a `failed` status
      after their retry is exhausted.
- [ ] Result view (FR10, FR10a, FR11): shows extracted fields, shows the
      partial-extraction notice under the correct independent conditions,
      never shows guessed data on a failed job.
- [ ] Follow-up action (FR12–FR14): triggers DeepSeek only on a completed
      job, validates against `ExpenseSummary`, supports retry-after-failure
      but not retrigger-after-success.
- [ ] Rate limiting (FR15, FR16): 429 with `Retry-After` once the hourly
      ceiling is hit on either endpoint; `RateLimitEvent` rows older than 2
      hours are cleaned up.
- [ ] Request validation order is exactly: resolve test user → rate limit →
      ownership check → business logic/provider call. No provider call
      happens before the ownership check.
- [ ] No file, credential, or `.env` value from any other project appears
      anywhere in this codebase, its config, or its migration history.
- [ ] No login, signup, password, or session code exists anywhere in the
      codebase.
- [ ] Every Non-Goal in PRD Section 3 remains unbuilt.
- [ ] Config values (temperature, token caps, timeouts, rate limits,
      concurrency cap) match Section 2 of this file exactly — none were
      "tuned."

---

## 7. What the agent does when unsure

You must never invent a new feature, expand scope, or guess at a
requirement the PRD doesn't specify. When you hit a genuine gap or
ambiguity:

1. **Stop before writing speculative code.** Do not produce a "best guess"
   implementation of an unspecified behavior and move on.
2. **Check the PRD's own Assumptions (Section 12) and Open Questions
   (Section 14) first** — many gaps are already flagged there with either a
   stated default or an explicit "this is unresolved."
3. **If the PRD has a stated default assumption, follow it exactly, and
   note in a comment which assumption you followed** (e.g. `// per PRD
   Section 12: no max job history cap enforced`).
4. **If the PRD has no answer at all, do not improvise one.** Leave a
   clearly marked `// TODO(PRD): <the exact open question>` at the smallest
   possible point in the code, implement the narrowest version that doesn't
   require guessing, and say so plainly in your summary of the work. A
   visible gap is always better than invented behavior.
5. **Never resolve ambiguity by adding more code "just in case."** If you
   are unsure whether something is in scope, treat it as out of scope and
   flag it, rather than building it defensively. Spaghetti built to cover
   an unclear requirement is a worse outcome than an honest gap.
6. **Never treat a locked choice (Section 2) as a suggestion.** If a locked
   value or dependency seems wrong for a reason the PRD doesn't address,
   say so in a comment and stop — do not silently swap it for something you
   judge to be better.
   