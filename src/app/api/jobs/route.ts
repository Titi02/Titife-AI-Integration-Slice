import { NextResponse } from "next/server";
import { getTestUser } from "@/lib/testUser";
import { checkRateLimit, recordRateLimitEvent } from "@/lib/rateLimit";
import { RateLimitEndpoint } from "@prisma/client";
import { config } from "@/lib/config";
import { prisma } from "@/lib/db/prisma";
import { uploadFileToStorage, generateStorageKey } from "@/lib/storage/s3";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    // 1. Resolve test user (FR0.1)
    const user = await getTestUser();

    // 2. Rate limit check (FR15)
    const rateLimit = await checkRateLimit(user.id, RateLimitEndpoint.upload);
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

    // 3. Ownership check (Vacuous in single-user mode, preserved for pattern consistency per AGENTS.md)
    if (!user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 4. Server-side file validation (FR1, FR2)
    const formData = await request.formData();
    const files = formData.getAll("files") as File[];

    if (files.length === 0) {
      return NextResponse.json(
        { error: "No files uploaded" },
        { status: 400 }
      );
    }

    if (files.length > config.upload.maxFilesPerBatch) {
      return NextResponse.json(
        {
          error: `Maximum ${config.upload.maxFilesPerBatch} files allowed per batch`,
        },
        { status: 400 }
      );
    }

    const maxSizeBytes = config.upload.maxFileSizeMb * 1024 * 1024;
    for (const file of files) {
      if (!config.upload.allowedMimeTypes.includes(file.type)) {
        return NextResponse.json(
          {
            error: `Invalid file type: ${file.name}. Allowed types: ${config.upload.allowedMimeTypes.join(", ")}`,
          },
          { status: 400 }
        );
      }
      if (file.size > maxSizeBytes) {
        return NextResponse.json(
          {
            error: `File too large: ${file.name}. Maximum allowed size is ${config.upload.maxFileSizeMb}MB`,
          },
          { status: 400 }
        );
      }
    }

    // 5. Upload files to Object Storage & Create Job rows (FR3, FR4)
    const createdJobIds: string[] = [];

    for (const file of files) {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Pre-generate the job id so the storage key (which embeds it) can be
      // computed before the row exists. The Job row is created only AFTER the
      // upload succeeds: creating a pending row first let the 3s-polling worker
      // claim a job whose object was not yet in R2, failing it with
      // "the specified key does not exist" (placeholder-key race).
      const jobId = crypto.randomUUID();
      const storageKey = generateStorageKey(user.id, jobId, file.name);

      // Upload file to Cloudflare R2 object storage (never in DB)
      await uploadFileToStorage(storageKey, buffer, file.type);

      const job = await prisma.job.create({
        data: {
          id: jobId,
          userId: user.id,
          fileName: file.name,
          mimeType: file.type,
          storageKey,
          status: "pending",
        },
      });

      createdJobIds.push(job.id);
    }

    // Record rate limit event
    await recordRateLimitEvent(user.id, RateLimitEndpoint.upload);

    // Return immediately without waiting for background extraction (FR4)
    return NextResponse.json({ jobIds: createdJobIds }, { status: 202 });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const user = await getTestUser();

    const jobs = await prisma.job.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: { followUp: true },
    });

    return NextResponse.json({ jobs });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
