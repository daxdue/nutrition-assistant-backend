import { Prisma } from "@prisma/client";
import { GuardCategory } from "./GuardCategory";
import { MealType } from "./MealType";
import { NutritionItem } from "./NutritionItem";

export type MealAnalysisResult = Prisma.JsonObject & {
    allowed: boolean;
    reason: string;
    category: GuardCategory;
    meal_type: MealType;
    items: NutritionItem[];
    total_estimated_kcal: number;
}