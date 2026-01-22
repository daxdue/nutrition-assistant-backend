/*
  Warnings:

  - A unique constraint covering the columns `[deviceTokenHash]` on the table `GarminDevice` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "GarminPairStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DENIED', 'EXPIRED', 'COMPLETED');

-- AlterTable
ALTER TABLE "GarminDevice" ADD COLUMN     "deviceTokenHash" TEXT,
ADD COLUMN     "tokenCreatedAt" TIMESTAMP(3),
ADD COLUMN     "tokenRevokedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "HydrationSettings" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ProviderAccount" ALTER COLUMN "scopes" DROP DEFAULT;

-- CreateTable
CREATE TABLE "GarminPairSession" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "wstHash" TEXT NOT NULL,
    "status" "GarminPairStatus" NOT NULL DEFAULT 'PENDING',
    "deviceId" TEXT NOT NULL,
    "deviceName" TEXT,
    "confirmedUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "claimCodeHash" TEXT,
    "claimCodeExpiresAt" TIMESTAMP(3),
    "claimCodeUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GarminPairSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GarminPairSession_state_key" ON "GarminPairSession"("state");

-- CreateIndex
CREATE INDEX "GarminPairSession_deviceId_idx" ON "GarminPairSession"("deviceId");

-- CreateIndex
CREATE INDEX "GarminPairSession_expiresAt_idx" ON "GarminPairSession"("expiresAt");

-- CreateIndex
CREATE INDEX "GarminPairSession_confirmedUserId_idx" ON "GarminPairSession"("confirmedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "GarminDevice_deviceTokenHash_key" ON "GarminDevice"("deviceTokenHash");
