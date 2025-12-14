/*
  Warnings:

  - A unique constraint covering the columns `[apiKey]` on the table `GarminDevice` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `apiKey` to the `GarminDevice` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "GarminDevice" ADD COLUMN     "apiKey" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "PairingToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PairingToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PairingToken_token_key" ON "PairingToken"("token");

-- CreateIndex
CREATE INDEX "PairingToken_token_idx" ON "PairingToken"("token");

-- CreateIndex
CREATE INDEX "PairingToken_userId_used_idx" ON "PairingToken"("userId", "used");

-- CreateIndex
CREATE UNIQUE INDEX "GarminDevice_apiKey_key" ON "GarminDevice"("apiKey");

-- CreateIndex
CREATE INDEX "GarminDevice_apiKey_idx" ON "GarminDevice"("apiKey");

-- AddForeignKey
ALTER TABLE "PairingToken" ADD CONSTRAINT "PairingToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
