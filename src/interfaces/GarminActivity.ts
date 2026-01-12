export interface GarminActivityExercise {
    name?: string;
    category?: string;
    reps?: number;
    sets?: number;
    weightKg?: number;
    durationSeconds?: number;
    distanceCm?: number;
}

export interface GarminActivity {
    type: string;
    subType?: string;
    name?: string;
    startTimestamp?: number;
    durationSeconds?: number;
    distanceCm?: number;
    caloriesKcal?: number;
    avgHeartRateBpm?: number;
    maxHeartRateBpm?: number;
    steps?: number;
    exercises?: GarminActivityExercise[];
}

export interface GarminActivitySummaryByType {
    type: string;
    count?: number;
    durationSeconds?: number;
    distanceCm?: number;
    caloriesKcal?: number;
}

export interface GarminActivitySummary {
    totalCount?: number;
    totalDurationSeconds?: number;
    totalDistanceCm?: number;
    totalCaloriesKcal?: number;
    byType?: GarminActivitySummaryByType[];
}
