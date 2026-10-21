-- AI Assistant: server-side conversations (memory, standing instructions, history).
ALTER TABLE "ai_query_logs" ADD COLUMN "conversation_id" TEXT, ADD COLUMN "response" JSONB;
CREATE INDEX "ai_query_logs_conversation_id_created_at_idx" ON "ai_query_logs"("conversation_id", "created_at");
CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "municipality_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_conversations_user_id_updated_at_idx" ON "ai_conversations"("user_id", "updated_at");
