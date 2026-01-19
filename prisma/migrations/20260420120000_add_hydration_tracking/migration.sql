-- CreateEnum
CREATE TYPE "HydrationSource" AS ENUM ('MANUAL', 'PROVIDER');

-- CreateEnum
CREATE TYPE "HydrationTargetMode" AS ENUM ('MANUAL', 'RECOMMENDED');

-- CreateEnum
CREATE TYPE "HydrationStatus" AS ENUM ('ON_TRACK', 'BEHIND', 'AHEAD', 'COMPLETE');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "weightKg" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "DailySummary" ADD COLUMN     "hydrationTargetMl" INTEGER,
ADD COLUMN     "hydrationRecommendedMl" INTEGER,
ADD COLUMN     "hydrationConsumedMl" INTEGER,
ADD COLUMN     "hydrationManualMl" INTEGER,
ADD COLUMN     "hydrationProviderMl" INTEGER,
ADD COLUMN     "hydrationStatus" "HydrationStatus",
ADD COLUMN     "hydrationTargetMode" "HydrationTargetMode",
ADD COLUMN     "temperatureAvgC" DOUBLE PRECISION,
ADD COLUMN     "temperatureMaxC" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "HydrationSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "targetMode" "HydrationTargetMode" NOT NULL DEFAULT 'MANUAL',
    "dailyTargetMl" INTEGER,
    "remindersEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reminderIntervalMinutes" INTEGER NOT NULL DEFAULT 120,
    "reminderStartHour" INTEGER NOT NULL DEFAULT 9,
    "reminderEndHour" INTEGER NOT NULL DEFAULT 21,
    "lastReminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HydrationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HydrationEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "volumeMl" INTEGER NOT NULL,
    "source" "HydrationSource" NOT NULL,
    "provider" "ActivityProvider",
    "providerMeta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HydrationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HydrationSettings_userId_key" ON "HydrationSettings"("userId");

-- CreateIndex
CREATE INDEX "HydrationEntry_userId_timestamp_idx" ON "HydrationEntry"("userId", "timestamp");

-- AddForeignKey
ALTER TABLE "HydrationSettings" ADD CONSTRAINT "HydrationSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HydrationEntry" ADD CONSTRAINT "HydrationEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
