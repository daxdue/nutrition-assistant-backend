-- CreateEnum
CREATE TYPE "AbuseCategory" AS ENUM ('NOT_MEAL', 'NUDITY', 'SEXUAL_CONTENT', 'VIOLENCE', 'SELF_HARM', 'HATE_SYMBOLS', 'DRUGS', 'WEAPON', 'OTHER');

-- AlterEnum
ALTER TYPE "UserStatus" ADD VALUE 'BANNED';

-- CreateTable
CREATE TABLE "AbuseEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "telegramUserId" BIGINT NOT NULL,
    "category" "AbuseCategory" NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbuseEvent_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "AbuseEvent" ADD CONSTRAINT "AbuseEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
