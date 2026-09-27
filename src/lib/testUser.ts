import { prisma } from "./db/prisma";
import { config } from "./config";

export async function getTestUser() {
  const user = await prisma.user.findUnique({
    where: { email: config.testUser.email },
  });

  if (!user) {
    throw new Error(
      `Test user (${config.testUser.email}) not found in database. Run "npx prisma db seed" first.`
    );
  }

  return user;
}
