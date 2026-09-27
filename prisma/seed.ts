import { PrismaClient } from "@prisma/client";
import { config } from "../src/lib/config";

const prisma = new PrismaClient();

async function main() {
  console.log(`Seeding test user (${config.testUser.email})...`);

  const user = await prisma.user.upsert({
    where: { email: config.testUser.email },
    update: {},
    create: {
      email: config.testUser.email,
    },
  });

  console.log(`Test user created/verified successfully with ID: ${user.id}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("Error during seed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
