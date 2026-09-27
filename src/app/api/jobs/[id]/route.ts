import { NextResponse } from "next/server";
import { getTestUser } from "@/lib/testUser";
import { prisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const user = await getTestUser();

    const job = await prisma.job.findUnique({
      where: { id },
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

    // Ownership check (single test user consistency)
    if (job.userId !== user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    return NextResponse.json({ job });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
