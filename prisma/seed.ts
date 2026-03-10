import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { seedSaraiknowsball } from "./seeds/saraiknowsball.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://nexus:nexus_dev@localhost:5434/nexus";

const pool = new Pool({ connectionString: DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log("[seed] Starting database seed...");
  await seedSaraiknowsball(prisma);
  console.log("[seed] ✅ All seeds complete");
}

main()
  .catch((e) => {
    console.error("[seed] ❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
