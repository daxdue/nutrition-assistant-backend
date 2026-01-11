-- Add correctionCount to FoodEntry for per-upload correction limits
ALTER TABLE "FoodEntry" ADD COLUMN "correctionCount" INTEGER NOT NULL DEFAULT 0;
