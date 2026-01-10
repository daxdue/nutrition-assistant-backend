-- AlterTable
ALTER TABLE "User" ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Europe/Istanbul';

-- AlterTable
ALTER TABLE "FoodEntry"
ADD COLUMN     "energyKcal" INTEGER,
ADD COLUMN     "proteinG" DOUBLE PRECISION,
ADD COLUMN     "carbsG" DOUBLE PRECISION,
ADD COLUMN     "fatG" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "DailySummary"
ADD COLUMN     "mealsCount" INTEGER,
ADD COLUMN     "nutritionKcal" INTEGER,
ADD COLUMN     "nutritionProteinG" DOUBLE PRECISION,
ADD COLUMN     "nutritionCarbsG" DOUBLE PRECISION,
ADD COLUMN     "nutritionFatG" DOUBLE PRECISION,
ADD COLUMN     "firstMealAt" TIMESTAMP(3),
ADD COLUMN     "lastMealAt" TIMESTAMP(3),
ADD COLUMN     "missingMacrosCount" INTEGER,
ADD COLUMN     "netKcalEstimate" INTEGER,
ADD COLUMN     "notes" TEXT;

-- CreateTable
CREATE TABLE "DailyAiReport" (
    "id" TEXT NOT NULL,
    "dailySummaryId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "inputJson" JSONB NOT NULL,
    "outputJson" JSONB NOT NULL,
    "messageText" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyAiReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyAiReport_dailySummaryId_key" ON "DailyAiReport"("dailySummaryId");

-- AddForeignKey
ALTER TABLE "DailyAiReport" ADD CONSTRAINT "DailyAiReport_dailySummaryId_fkey"
  FOREIGN KEY ("dailySummaryId") REFERENCES "DailySummary"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
