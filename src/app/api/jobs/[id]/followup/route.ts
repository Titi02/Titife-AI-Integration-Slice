import { NextResponse } from "next/server";
import { getTestUser } from "@/lib/testUser";
import { checkRateLimit, recordRateLimitEvent } from "@/lib/rateLimit";
import { RateLimitEndpoint } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { config } from "@/lib/config";
import { summarizeExpenseData } from "@/lib/ai/deepseek";
import { ExpenseSummary, ExpenseExtractionType } from "@/lib/ai/schemas";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: jobId } = await params;
    // 1. Resolve test user (FR0.1)
    const user = await getTestUser();

    // 2. Rate limit check (FR16)
    const rateLimit = await checkRateLimit(user.id, RateLimitEndpoint.followup);
    if (!rateLimit.allowed) {
      return new NextResponse(
        JSON.stringify({ error: "Rate limit exceeded" }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": rateLimit.retryAfterSeconds.toString(),
          },
        }
      );
    }

    // 3. Ownership & Job status check
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: {
        followUp: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (job.userId !== user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    if (job.status !== "done" || !job.extraction) {
      return NextResponse.json(
        { error: "Follow-up action requires job to be completed" },
        { status: 400 }
      );
    }

    // FR12: Retriggering after a successful summary is NOT supported
    const lastFollowUp = job.followUp[0];
    if (lastFollowUp && lastFollowUp.status === "done") {
      return NextResponse.json(
        { error: "Follow-up action already completed for this job" },
        { status: 400 }
      );
    }

    // Record rate limit event
    await recordRateLimitEvent(user.id, RateLimitEndpoint.followup);

    // Create FollowUpAction record (FR13, FR13a)
    const followUpAction = await prisma.followUpAction.create({
      data: {
        jobId,
        status: "processing",
        attempts: 1,
      },
    });

    // Execute DeepSeek summary call
    let attempts = 1;
    let callResult;
    let providerError: Error | null = null;

    try {
      callResult = await summarizeExpenseData(
        job.extraction as unknown as ExpenseExtractionType
      );
    } catch (err: any) {
      providerError = err;
    }

    // FR14 Provider error retry. attempts counts calls starting at 1, so the
    // config value `providerRetries` gates `attempts < 1 + providerRetries`.
    if (providerError && attempts < 1 + config.retries.providerRetries) {
      try {
        attempts++;
        providerError = null;
        callResult = await summarizeExpenseData(
          job.extraction as unknown as ExpenseExtractionType
        );
      } catch (err: any) {
        providerError = err;
      }
    }

    if (providerError) {
      const updated = await prisma.followUpAction.update({
        where: { id: followUpAction.id },
        data: {
          status: "failed",
          attempts,
          errorMessage: `[provider_unavailable] DeepSeek API call failed: ${providerError.message}`,
        },
      });
      return NextResponse.json({ followUp: updated }, { status: 200 });
    }

    if (!callResult) {
      const updated = await prisma.followUpAction.update({
        where: { id: followUpAction.id },
        data: {
          status: "failed",
          attempts,
          errorMessage: "[provider_unavailable] Empty response from DeepSeek API",
        },
      });
      return NextResponse.json({ followUp: updated }, { status: 200 });
    }

    // Zod Validation against ExpenseSummary schema (FR14)
    let jsonParsed: unknown = null;
    try {
      jsonParsed = JSON.parse(callResult.rawOutput);
    } catch (e) {
      jsonParsed = null;
    }

    let zodResult = jsonParsed ? ExpenseSummary.safeParse(jsonParsed) : null;

    // FR14 Corrective prompt retry path on validation failure
    if (!zodResult?.success && attempts < 1 + config.retries.validationRetries) {
      try {
        attempts++;
        callResult = await summarizeExpenseData(
          job.extraction as unknown as ExpenseExtractionType,
          { extraPrompt: "Output must be valid JSON matching format {\"summary\": \"text\"} under 500 characters." }
        );
        try {
          jsonParsed = JSON.parse(callResult.rawOutput);
          zodResult = ExpenseSummary.safeParse(jsonParsed);
        } catch (e) {
          zodResult = null;
        }
      } catch (retryError: any) {
        // Provider/timeout/API failure during the validation retry — record it
        // honestly instead of misclassifying it as invalid_output.
        const updated = await prisma.followUpAction.update({
          where: { id: followUpAction.id },
          data: {
            status: "failed",
            attempts,
            rawOutput: callResult?.rawOutput ?? null,
            errorMessage: `[provider_unavailable] DeepSeek API call failed: ${retryError.message}`,
          },
        });
        return NextResponse.json({ followUp: updated }, { status: 200 });
      }
    }

    if (zodResult && zodResult.success) {
      const updated = await prisma.followUpAction.update({
        where: { id: followUpAction.id },
        data: {
          status: "done",
          attempts,
          summary: zodResult.data.summary,
          rawOutput: callResult.rawOutput,
          inputTokens: callResult.inputTokens,
          outputTokens: callResult.outputTokens,
        },
      });
      return NextResponse.json({ followUp: updated }, { status: 200 });
    } else {
      const updated = await prisma.followUpAction.update({
        where: { id: followUpAction.id },
        data: {
          status: "failed",
          attempts,
          rawOutput: callResult.rawOutput,
          errorMessage: "[invalid_output] Summary schema validation failed",
          inputTokens: callResult.inputTokens,
          outputTokens: callResult.outputTokens,
        },
      });
      return NextResponse.json({ followUp: updated }, { status: 200 });
    }
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: jobId } = await params;
    const user = await getTestUser();

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { userId: true },
    });

    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    if (job.userId !== user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const followUp = await prisma.followUpAction.findFirst({
      where: { jobId },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ followUp });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
