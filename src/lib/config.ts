export const config = {
  testUser: { email: "test@local.dev" },
  models: {
    extractor: { provider: "gemini", model: "gemini-3.6-flash" },
    followup: {
      provider: "deepseek",
      model: "deepseek-chat",
      // DeepSeek is intentionally called through its OpenAI-compatible API
      baseUrl: "https://api.deepseek.com",
    },
  },
  timeouts: { extractorMs: 20000, followupMs: 15000 },
  tokenCaps: {
    extractorMaxOutput: 2048,
    extractorTruncationRetryMaxOutput: 3072,
    followupMaxOutput: 200,
  },
  temperature: { extractor: 0.1, followup: 0.4 },
  generation: {
    // FR6: extractor and follow-up outputs must be returned as structured
    // JSON; these response modes must stay in lockstep with responseSchema.
    extractorResponseMimeType: "application/json",
    followupResponseFormat: "json_object",
  } as const,
  rateLimits: { uploadsPerHour: 10, followupsPerHour: 20 },
  concurrency: {
    // Worker caps concurrent Gemini extraction jobs in this process (FR9).
    cap: 2,
    // Caps concurrent DeepSeek follow-up calls via an in-process semaphore
    // (follow-up runs in the web process, not the worker).
    followupCap: 2,
  },
  retries: {
    validationRetries: 1,
    providerRetries: 1,
    truncationRetries: 1,
    // FR8: fixed delay the worker waits between provider-error retries
    providerBackoffMs: 2000,
  },
  rateLimitRetentionHours: 2,
  rateLimitWindowMs: 60 * 60 * 1000, // 1-hour sliding window for per-hour limits
  worker: {
    // Polling/sweep cadence and crashed-worker detection threshold.
    pollIntervalMs: 3000,
    sweepIntervalMs: 30000,
    // Locked rule (AGENTS.md §2): 60s without an update = crashed mid-call; the
    // sweep grants exactly one re-attempt before failing. Do not retune.
    stuckJobTimeoutMs: 60000,
  },
  upload: {
    maxFileSizeMb: 10,
    maxFilesPerBatch: 5,
    allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
  },
};
