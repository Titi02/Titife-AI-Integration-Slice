import { RateLimitEndpoint } from "@prisma/client";
import { prisma } from "./db/prisma";
import { config } from "./config";

export async function checkRateLimit(
  userId: string,
  endpoint: RateLimitEndpoint
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const windowMs = config.rateLimitWindowMs;
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowMs);

  const maxRequests =
    endpoint === RateLimitEndpoint.upload
      ? config.rateLimits.uploadsPerHour
      : config.rateLimits.followupsPerHour;

  // Cleanup events older than configured retention hours (2h retention rule per PRD Section 7)
  const retentionStart = new Date(
    now.getTime() - config.rateLimitRetentionHours * 60 * 60 * 1000
  );
  try {
    await prisma.rateLimitEvent.deleteMany({
      where: {
        createdAt: { lt: retentionStart },
      },
    });
  } catch (err) {
    console.warn("[RateLimit Retention Warning] Failed to delete expired events:", err);
  }

  const count = await prisma.rateLimitEvent.count({
    where: {
      userId,
      endpoint,
      createdAt: { gte: windowStart },
    },
  });

  if (count >= maxRequests) {
    const oldestInWindow = await prisma.rateLimitEvent.findFirst({
      where: {
        userId,
        endpoint,
        createdAt: { gte: windowStart },
      },
      orderBy: { createdAt: "asc" },
    });

    const resetTime = oldestInWindow
      ? new Date(oldestInWindow.createdAt.getTime() + windowMs)
      : new Date(now.getTime() + windowMs);

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((resetTime.getTime() - now.getTime()) / 1000)
    );

    return { allowed: false, retryAfterSeconds };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

export async function recordRateLimitEvent(
  userId: string,
  endpoint: RateLimitEndpoint
): Promise<void> {
  await prisma.rateLimitEvent.create({
    data: {
      userId,
      endpoint,
    },
  });
}
