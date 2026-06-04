import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  if (process.env.CONFIRM_DB_RESET !== "YES") {
    throw new Error(
      "Refusing to run. Set CONFIRM_DB_RESET=YES to wipe the database."
    );
  }

  await prisma.$transaction([
    prisma.notification.deleteMany(),
    prisma.activityLog.deleteMany(),
    prisma.report.deleteMany(),
    prisma.chatMessage.deleteMany(),
    prisma.chat.deleteMany(),
    prisma.like.deleteMany(),
    prisma.review.deleteMany(),
    prisma.mod.deleteMany(),
    prisma.user.deleteMany(),
  ]);

  console.log("✅ Database wiped.");
}

main()
  .catch((err) => {
    console.error("❌ DB reset failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
