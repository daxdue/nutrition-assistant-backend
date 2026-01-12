-- AlterTable
ALTER TABLE "DailySummary" ADD COLUMN     "nutritionFiberG" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "FoodEntry" ADD COLUMN     "fiberG" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "ProviderAccount" ALTER COLUMN "scopes" DROP DEFAULT;
