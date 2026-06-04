import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();
const BCRYPT_ROUNDS = 12;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function main() {
  const email = requireEnv("OWNER_EMAIL");
  const username = requireEnv("OWNER_USERNAME");
  const displayName = requireEnv("OWNER_DISPLAY_NAME");
  const password = requireEnv("OWNER_PASSWORD");

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const existing = await prisma.user.findFirst({
    where: {
      OR: [{ email }, { username }],
    },
  });

  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        email,
        username,
        displayName,
        passwordHash,
        role: "owner",
        status: "active",
        isVerified: true,
        verifiedAt: new Date(),
      },
    });

    console.log("✅ Owner account updated:", email);
    return;
  }

  await prisma.user.create({
    data: {
      email,
      username,
      displayName,
      passwordHash,
      role: "owner",
      status: "active",
      isVerified: true,
      verifiedAt: new Date(),
    },
  });

  console.log("✅ Owner account created:", email);
}

main()
  .catch((err) => {
    console.error("❌ Owner creation failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
