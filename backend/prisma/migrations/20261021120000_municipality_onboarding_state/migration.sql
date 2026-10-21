-- Getting Started guide state (acknowledged optional steps, dismissed flag).
ALTER TABLE "municipalities" ADD COLUMN "onboarding_state" JSONB NOT NULL DEFAULT '{}';
