-- AlterTable
ALTER TABLE "GarminDevice" ADD COLUMN     "firmwareVersion" TEXT,
ADD COLUMN     "deviceName" TEXT;

-- AlterTable
ALTER TABLE "DailySummary"
ADD COLUMN     "schemaVersion" TEXT,
ADD COLUMN     "dayStartTimestamp" TIMESTAMP(3),
ADD COLUMN     "totalCaloriesKcal" INTEGER,
ADD COLUMN     "distanceCm" INTEGER,
ADD COLUMN     "floorsDescended" INTEGER,
ADD COLUMN     "floorsClimbed" INTEGER,
ADD COLUMN     "deviceBatteryPercent" INTEGER,
ADD COLUMN     "deviceMemoryFreeBytes" INTEGER,
ADD COLUMN     "activeMinutesTotal" INTEGER,
ADD COLUMN     "activeMinutesVigorous" INTEGER,
ADD COLUMN     "activeMinutesModerate" INTEGER,
ADD COLUMN     "bodyBatteryDailyStart" INTEGER,
ADD COLUMN     "bodyBatteryDailyEnd" INTEGER,
ADD COLUMN     "bodyBatteryDailyMin" INTEGER,
ADD COLUMN     "bodyBatteryDailyMax" INTEGER,
ADD COLUMN     "bodyBatteryDailyCharged" INTEGER,
ADD COLUMN     "bodyBatteryDailyDrained" INTEGER,
ADD COLUMN     "bodyBatteryDailyNetChange" INTEGER,
ADD COLUMN     "bodyBatteryDailySampleCount" INTEGER,
ADD COLUMN     "stressMin" INTEGER,
ADD COLUMN     "stressMax" INTEGER,
ADD COLUMN     "stressSampleCount" INTEGER,
ADD COLUMN     "heartRateAvgBpm" INTEGER,
ADD COLUMN     "heartRateMinBpm" INTEGER,
ADD COLUMN     "heartRateMaxBpm" INTEGER,
ADD COLUMN     "heartRateSampleCount" INTEGER,
ADD COLUMN     "spo2AvgPercent" DOUBLE PRECISION,
ADD COLUMN     "spo2MinPercent" DOUBLE PRECISION,
ADD COLUMN     "spo2MaxPercent" DOUBLE PRECISION,
ADD COLUMN     "spo2SampleCount" INTEGER;

-- AlterTable
ALTER TABLE "DailySummary" ALTER COLUMN "stressAvg" TYPE DOUBLE PRECISION;
