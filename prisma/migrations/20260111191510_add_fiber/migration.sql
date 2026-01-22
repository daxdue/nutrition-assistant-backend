-- AlterTable
ALTER TABLE "DailySummary" ADD COLUMN     "nutritionFiberG" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "FoodEntry" ADD COLUMN     "fiberG" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE IF EXISTS "ProviderAccount" ALTER COLUMN "scopes" DROP DEFAULT;
