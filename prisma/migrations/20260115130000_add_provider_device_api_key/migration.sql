-- AlterTable
ALTER TABLE "ProviderDevice" ADD COLUMN     "deviceApiKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ProviderDevice_deviceApiKey_key" ON "ProviderDevice"("deviceApiKey");
