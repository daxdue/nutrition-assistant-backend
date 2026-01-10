DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProviderAccountStatus') THEN
    CREATE TYPE "ProviderAccountStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED', 'ERROR');
  END IF;
END $$;

-- Normalize status values and enforce enum + default
ALTER TABLE "ProviderAccount"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "ProviderAccountStatus"
    USING (
      CASE
        WHEN "status" IS NULL THEN 'ACTIVE'
        WHEN "status" IN ('ACTIVE', 'REVOKED', 'EXPIRED', 'ERROR') THEN "status"::"ProviderAccountStatus"
        ELSE 'ACTIVE'
      END
    ),
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE',
  ALTER COLUMN "status" SET NOT NULL;

-- Normalize scopes column to a non-null array
ALTER TABLE "ProviderAccount"
  ALTER COLUMN "scopes" TYPE TEXT[] USING ARRAY[]::TEXT[],
  ALTER COLUMN "scopes" SET DEFAULT ARRAY[]::TEXT[],
  ALTER COLUMN "scopes" SET NOT NULL;
