import { prisma } from "../lib/db/prisma";
import { config } from "../lib/config";
import { getFileFromStorage } from "../lib/storage/s3";
import { extractExpenseData } from "../lib/ai/gemini";
import { ExpenseExtraction } from "../lib/ai/schemas";

console.log("Starting receipt extraction worker process...");
console.log(`Worker configuration: Concurrency Cap = ${config.concurrency.cap}`);

let isRunning = true;
let activeJobsCount = 0;

async function sweepStuckJobs() {
  if (!isRunning) return;

  try {
    const sixtySecondsAgo = new Date(
      Date.now() - config.worker.stuckJobTimeoutMs
    );

    // Find jobs stuck in processing for > 60 seconds without update (crashed worker recovery)
    const stuckJobs = await prisma.job.findMany({
      where: {
        status: "processing",
        updatedAt: { lt: sixtySecondsAgo },
      },
    });

    for (const job of stuckJobs) {
      if (job.attempts < 2) {
        console.warn(
          `[Worker Sweep] Resetting stuck job ${job.id} (attempts: ${job.attempts}) back to pending for re-attempt.`
        );
        await prisma.job.update({
          where: { id: job.id },
          data: { status: "pending" },
        });
      } else {
        console.error(
          `[Worker Sweep] Marking stuck job ${job.id} as failed after exhausting attempts.`
        );
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: "failed",
            errorMessage:
              "[provider_unavailable] Job timed out in processing state after 60 seconds",
          },
        });
      }
    }
  } catch (err) {
    console.error("[Worker Sweep Error] Error running stuck job sweep:", err);
  }
}

async function processJob(job: {
  id: string;
  storageKey: string;
  mimeType: string;
}) {
  console.log(`[Worker] Starting processing for Job ID: ${job.id}`);

  let attempts = 0;
  let fileBuffer: Buffer;

  try {
    fileBuffer = await getFileFromStorage(job.storageKey);
  } catch (err: any) {
    console.error(`[Worker Error] Failed to read storage key for Job ${job.id}:`, err);
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "failed",
        errorMessage: `[provider_unavailable] Failed to retrieve object from storage: ${err.message}`,
      },
    });
    return;
  }

  let extractionResult;
  let providerError: Error | null = null;

  try {
    attempts++;
    extractionResult = await extractExpenseData(fileBuffer, job.mimeType);
  } catch (err: any) {
    providerError = err;
    console.warn(`[Worker Provider Warning] Attempt 1 failed for Job ${job.id}: ${err.message}`);
  }

  // FR8 Retry path for provider-level errors (timeout, network, 5xx)
  if (providerError && attempts < config.retries.providerRetries + 1) {
    console.log(`[Worker] Retrying Job ${job.id} after provider error...`);
    await new Promise((res) => setTimeout(res, config.retries.providerBackoffMs));
    try {
      attempts++;
      providerError = null;
      extractionResult = await extractExpenseData(fileBuffer, job.mimeType);
    } catch (err: any) {
      providerError = err;
    }
  }

  if (providerError) {
    console.error(`[Worker Error] Job ${job.id} failed after provider retries.`);
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "failed",
        attempts,
        errorMessage: `[provider_unavailable] Provider call failed: ${providerError.message}`,
      },
    });
    return;
  }

  if (!extractionResult) return;

  let jsonParsed: unknown = null;
  let isTruncated = false;

  try {
    jsonParsed = JSON.parse(extractionResult.rawOutput);
  } catch (parseErr) {
    isTruncated = true;
  }

  let zodResult = jsonParsed ? ExpenseExtraction.safeParse(jsonParsed) : null;

  // FR7a Truncation Retry Path (maxOutputTokens = 3072). attempts counts calls
  // starting at 1, so `retries` maps to the gate `1 + retries`.
  if (isTruncated && attempts <= 1 + config.retries.truncationRetries) {
    console.log(`[Worker] Truncation detected on Job ${job.id}. Retrying with maxOutputTokens 3072...`);
    try {
      attempts++;
      extractionResult = await extractExpenseData(fileBuffer, job.mimeType, {
        maxOutputTokens: config.tokenCaps.extractorTruncationRetryMaxOutput,
      });
      try {
        jsonParsed = JSON.parse(extractionResult.rawOutput);
        zodResult = ExpenseExtraction.safeParse(jsonParsed);
      } catch (e) {
        // Still invalid JSON
      }
    } catch (err: any) {
      console.error(`[Worker Error] Truncation retry provider error for Job ${job.id}:`, err);
    }
  }

  // FR7 Validation Failure Retry Path (corrective prompt)
  if (
    !zodResult?.success &&
    attempts <= 1 + config.retries.validationRetries &&
    !isTruncated
  ) {
    const issueSummary = zodResult
      ? zodResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      : "Invalid JSON format";

    console.log(`[Worker] Validation failed on Job ${job.id}. Retrying with corrective prompt...`);
    try {
      attempts++;
      extractionResult = await extractExpenseData(fileBuffer, job.mimeType, {
        extraPrompt: `Previous extraction failed validation. Issues to fix: ${issueSummary}`,
      });
      try {
        jsonParsed = JSON.parse(extractionResult.rawOutput);
        zodResult = ExpenseExtraction.safeParse(jsonParsed);
      } catch (e) {
        // Still invalid
      }
    } catch (err: any) {
      console.error(`[Worker Error] Validation retry provider error for Job ${job.id}:`, err);
    }
  }

  if (zodResult && zodResult.success) {
    console.log(`[Worker Success] Job ${job.id} completed successfully.`);
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "done",
        attempts,
        extraction: zodResult.data as any,
        rawOutput: extractionResult.rawOutput,
        inputTokens: extractionResult.inputTokens,
        outputTokens: extractionResult.outputTokens,
      },
    });
  } else {
    const errorDetails = zodResult && !zodResult.success
      ? zodResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")
      : "Output was not valid JSON";

    console.error(`[Worker Validation Failed] Job ${job.id} failed schema validation: ${errorDetails}`);
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "failed",
        attempts,
        rawOutput: extractionResult.rawOutput,
        errorMessage: `[invalid_output] Schema validation failed: ${errorDetails}`,
        inputTokens: extractionResult.inputTokens,
        outputTokens: extractionResult.outputTokens,
      },
    });
  }
}

async function pollJobs() {
  if (!isRunning) return;

  try {
    const availableSlots = config.concurrency.cap - activeJobsCount;
    if (availableSlots > 0) {
      const pendingJobs = await prisma.job.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
        take: availableSlots,
      });

      for (const job of pendingJobs) {
        const claimed = await prisma.job.updateMany({
          where: { id: job.id, status: "pending" },
          data: { status: "processing" },
        });

        if (claimed.count > 0) {
          activeJobsCount++;
          processJob(job).finally(() => {
            activeJobsCount--;
          });
        }
      }
    }
  } catch (error) {
    console.error("[Worker Error] Polling error:", error);
  } finally {
    if (isRunning) {
      setTimeout(pollJobs, config.worker.pollIntervalMs);
    }
  }
}

// Start worker polling loop & 30-second stuck-job sweep
pollJobs();
setInterval(sweepStuckJobs, config.worker.sweepIntervalMs);

process.on("SIGINT", async () => {
  console.log("Shutting down worker process...");
  isRunning = false;
  await prisma.$disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("Shutting down worker process...");
  isRunning = false;
  await prisma.$disconnect();
  process.exit(0);
});
