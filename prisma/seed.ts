import { PrismaClient, Role, type Severity } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

// Demo accounts. Override the admin password outside local development.
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "Admin@12345";
const DEMO_PASSWORD = "Demo@12345";

const REWARD_TIERS: Record<Severity, number> = {
  LOW: 10_000,
  MEDIUM: 50_000,
  HIGH: 150_000,
  CRITICAL: 500_000,
};

async function upsertUser(email: string, name: string, role: Role, password: string) {
  const passwordHash = await bcrypt.hash(password, 10);
  return prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name, role, passwordHash },
  });
}

async function main() {
  await upsertUser("admin@bugbounty.dev", "Platform Admin", Role.ADMIN, ADMIN_PASSWORD);
  const owner = await upsertUser(
    "owner@bugbounty.dev",
    "Acme Security",
    Role.PROGRAM_OWNER,
    DEMO_PASSWORD,
  );
  await upsertUser("researcher@bugbounty.dev", "Riley Researcher", Role.RESEARCHER, DEMO_PASSWORD);

  const title = "Acme Web Application";
  const existing = await prisma.program.findFirst({ where: { ownerId: owner.id, title } });
  if (existing) return;

  await prisma.program.create({
    data: {
      ownerId: owner.id,
      title,
      description: "Public bug bounty for the Acme customer portal and API.",
      scope: { inScope: ["app.acme.test", "api.acme.test"], outOfScope: ["status.acme.test"] },
      status: "ACTIVE",
      poolBalance: 1_000_000,
      rewardTiers: {
        create: Object.entries(REWARD_TIERS).map(([severity, amount]) => ({
          severity: severity as Severity,
          amount,
        })),
      },
    },
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
