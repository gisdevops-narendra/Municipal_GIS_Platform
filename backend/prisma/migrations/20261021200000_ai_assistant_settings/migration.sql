-- AI Assistant settings: pinned chats + municipality-wide setting defaults.
ALTER TABLE "ai_conversations" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "municipality_settings" (
    "municipality_id" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "municipality_settings_pkey" PRIMARY KEY ("municipality_id")
);
