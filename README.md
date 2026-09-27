# The AI Integration Slice

A single-flow web app that turns uploaded receipt images or PDFs into validated, structured expense records — and, on request, into a plain-language summary of that expense.

**Demonstrates:** correct, cost-aware AI integration — async background processing, structured output validated before it reaches the UI or the database, honest job tracking, sliding-window rate limits, and visible failure reporting.

**Key technologies:** Next.js 15 + React 19 + TypeScript · Prisma + PostgreSQL · Gemini (`gemini-3.6-flash`) via `@google/genai` for extraction · DeepSeek (`deepseek-chat`) via the `openai` SDK for the follow-up · Zod for every structured input and model output · Cloudflare R2 (S3-compatible) via `@aws-sdk/client-s3` for file storage · a standalone Node worker as the job queue (no Redis, no BullMQ, no external queue service)

**Features:**
- Batch upload of up to 5 PDF/JPEG/PNG receipts (10 MB each), re-validated server-side
- Returns `202` immediately; no HTTP request ever waits on a model call
- Background worker with atomic job claiming, a concurrency cap of 2, and stuck-job recovery
- Zod-validated extraction with line items, a confidence note, and a partial-extraction notice
- Optional "Summarize this expense" follow-up built from the validated record
- Rate limits (10 uploads/hr, 20 follow-ups/hr) returning `429` with `Retry-After`
- Failures always recorded with a real message: `[provider_unavailable]` or `[invalid_output]`
- One seeded test user (`test@local.dev`) — no login of any kind

**Local setup:** `npm install` → copy `.env.example` to `.env` and fill in your values → `npx prisma migrate dev` → `npx prisma db seed` (idempotent, safe to re-run)

**Required environment variables:** `DATABASE_URL`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_REGION`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`

**Run:** `npm run dev` for the app (http://localhost:3000) and `npm run worker` in a second terminal

**Documentation:** [DOCUMENTATION.md](./DOCUMENTATION.md) — full technical documentation, including the end-to-end flow, data model, design decisions, and failure modes.
