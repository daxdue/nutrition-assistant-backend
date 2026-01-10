require("dotenv/config");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function backfillProviders() {
  const enumCheck = await prisma.$queryRaw`
    SELECT 1
    FROM pg_type
    WHERE typname = 'ProviderAccountStatus'
    LIMIT 1
  `;
  if (!Array.isArray(enumCheck) || enumCheck.length === 0) {
    console.warn("ProviderAccountStatus enum not found. Skipping backfill (run migrations first).");
    return;
  }

  const devices = await prisma.garminDevice.findMany();
  let accountsCreated = 0;
  let devicesUpserted = 0;

  for (const device of devices) {
    const account = await prisma.providerAccount.upsert({
      where: { userId_provider: { userId: device.userId, provider: "GARMIN" } },
      update: {
        status: "ACTIVE",
        scopes: ["write"],
      },
      create: {
        userId: device.userId,
        provider: "GARMIN",
        scopes: ["write"],
        status: "ACTIVE",
      },
    });

    accountsCreated += 1;

    await prisma.providerDevice.upsert({
      where: {
        providerAccountId_externalDeviceId: {
          providerAccountId: account.id,
          externalDeviceId: device.deviceId,
        },
      },
      update: {
        deviceApiKey: device.apiKey,
        model: device.model ?? undefined,
        firmwareVersion: device.firmwareVersion ?? undefined,
        deviceName: device.deviceName ?? undefined,
      },
      create: {
        providerAccountId: account.id,
        externalDeviceId: device.deviceId,
        deviceApiKey: device.apiKey,
        model: device.model ?? undefined,
        firmwareVersion: device.firmwareVersion ?? undefined,
        deviceName: device.deviceName ?? undefined,
      },
    });

    devicesUpserted += 1;
  }

  console.log(`Backfill complete: ${accountsCreated} accounts processed, ${devicesUpserted} devices upserted.`);
}

backfillProviders()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
