// Imported lazily: a test file may set env vars before the config is first loaded.
afterAll(async () => {
  const { prisma } = await import("../../src/config/prisma");
  await prisma.$disconnect();
});
