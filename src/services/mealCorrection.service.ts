import { prisma } from "../db/client";
import { MealAnalysisResult } from "../interfaces/MealAnalysisResult";
import { applyNutritionCorrections } from "../modules/ai/nutrition.correction.service";
import { MAX_MEAL_CORRECTIONS_PER_ENTRY } from "../config/limits";
import { deriveEntryTotals } from "../utils/mealAnalysis";

export class MealCorrectionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MealCorrectionLimitError";
  }
}

export class MealCorrectionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MealCorrectionNotFoundError";
  }
}

export class MealCorrectionInvalidAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MealCorrectionInvalidAnalysisError";
  }
}

export class MealCorrectionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MealCorrectionRejectedError";
  }
}

interface ApplyMealCorrectionArgs {
  entryId: string;
  userId: string;
  correctionText: string;
}

export interface MealCorrectionResult {
  entry: {
    id: string;
    timestamp: Date;
    imagePathOrUrl: string;
    captionText: string | null;
    aiParsedJson: MealAnalysisResult | null;
    correctionCount: number;
  };
  correctionsRemaining: number;
  maxCorrections: number;
}

export async function applyMealCorrection({
  entryId,
  userId,
  correctionText,
}: ApplyMealCorrectionArgs): Promise<MealCorrectionResult> {
  if (MAX_MEAL_CORRECTIONS_PER_ENTRY <= 0) {
    throw new MealCorrectionLimitError("Corrections are disabled.");
  }

  const entry = await prisma.foodEntry.findFirst({
    where: { id: entryId, userId },
  });

  if (!entry) {
    throw new MealCorrectionNotFoundError("Food entry not found.");
  }

  const currentAnalysis = entry.aiParsedJson as MealAnalysisResult | null;
  if (!currentAnalysis) {
    throw new MealCorrectionInvalidAnalysisError("No analysis data to correct.");
  }

  const correctionCount = entry.correctionCount ?? 0;
  if (correctionCount >= MAX_MEAL_CORRECTIONS_PER_ENTRY) {
    throw new MealCorrectionLimitError("Correction limit reached.");
  }

  const trimmedCorrection = correctionText.trim();
  if (!trimmedCorrection) {
    throw new MealCorrectionInvalidAnalysisError("Correction text is empty.");
  }

  const corrected = await applyNutritionCorrections(
    currentAnalysis,
    trimmedCorrection
  );

  if (!corrected.allowed) {
    await prisma.foodEntry.update({
      where: { id: entry.id },
      data: { correctionCount: { increment: 1 } },
    });
    throw new MealCorrectionRejectedError("Correction was rejected by the model.");
  }

  const { energyKcal, proteinG, carbsG, fatG, fiberG } = deriveEntryTotals(
    corrected
  );

  const updated = await prisma.foodEntry.update({
    where: { id: entry.id },
    data: {
      aiParsedJson: corrected,
      energyKcal,
      proteinG,
      carbsG,
      fatG,
      fiberG,
      correctionCount: { increment: 1 },
    },
    select: {
      id: true,
      timestamp: true,
      imagePathOrUrl: true,
      captionText: true,
      aiParsedJson: true,
      correctionCount: true,
    },
  });

  const correctionsRemaining = Math.max(
    0,
    MAX_MEAL_CORRECTIONS_PER_ENTRY - (updated.correctionCount ?? 0)
  );

  return {
    entry: {
      id: updated.id,
      timestamp: updated.timestamp,
      imagePathOrUrl: updated.imagePathOrUrl,
      captionText: updated.captionText,
      aiParsedJson: updated.aiParsedJson as MealAnalysisResult | null,
      correctionCount: updated.correctionCount ?? 0,
    },
    correctionsRemaining,
    maxCorrections: MAX_MEAL_CORRECTIONS_PER_ENTRY,
  };
}
