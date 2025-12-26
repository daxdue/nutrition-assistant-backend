-- CreateEnum
CREATE TYPE "ActivityProvider" AS ENUM ('GARMIN', 'STRAVA', 'APPLE_HEALTH', 'OTHER');

-- AlterTable
ALTER TABLE "DailySummary"
ADD COLUMN     "providersPresent" JSONB,
ADD COLUMN     "providerPrimary" "ActivityProvider",
ADD COLUMN     "metricSources" JSONB,
ADD COLUMN     "providerMetaJson" JSONB;

-- CreateTable
CREATE TABLE "ProviderAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "ActivityProvider" NOT NULL,
    "externalUserId" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT,
    "status" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderDevice" (
    "id" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "externalDeviceId" TEXT,
    "model" TEXT,
    "firmwareVersion" TEXT,
    "deviceName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderIngestion" (
    "id" TEXT NOT NULL,
    "provider" "ActivityProvider" NOT NULL,
    "userId" TEXT NOT NULL,
    "providerAccountId" TEXT,
    "payloadHash" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceTimestamp" TIMESTAMP(3),
    "dayStartUtc" TIMESTAMP(3) NOT NULL,
    "schemaVersion" TEXT,
    "status" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "ProviderIngestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderAccount_userId_provider_key" ON "ProviderAccount"("userId", "provider");

-- CreateIndex
CREATE INDEX "ProviderAccount_provider_externalUserId_idx" ON "ProviderAccount"("provider", "externalUserId");

-- CreateIndex
CREATE INDEX "ProviderDevice_providerAccountId_externalDeviceId_idx" ON "ProviderDevice"("providerAccountId", "externalDeviceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderDevice_providerAccountId_externalDeviceId_key" ON "ProviderDevice"("providerAccountId", "externalDeviceId");

-- CreateIndex
CREATE INDEX "ProviderIngestion_userId_dayStartUtc_idx" ON "ProviderIngestion"("userId", "dayStartUtc");

-- CreateIndex
CREATE INDEX "ProviderIngestion_provider_payloadHash_idx" ON "ProviderIngestion"("provider", "payloadHash");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderIngestion_provider_userId_dayStartUtc_payloadHash_key" ON "ProviderIngestion"("provider", "userId", "dayStartUtc", "payloadHash");

-- AddForeignKey
ALTER TABLE "ProviderAccount" ADD CONSTRAINT "ProviderAccount_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderDevice" ADD CONSTRAINT "ProviderDevice_providerAccountId_fkey"
  FOREIGN KEY ("providerAccountId") REFERENCES "ProviderAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderIngestion" ADD CONSTRAINT "ProviderIngestion_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderIngestion" ADD CONSTRAINT "ProviderIngestion_providerAccountId_fkey"
  FOREIGN KEY ("providerAccountId") REFERENCES "ProviderAccount"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
