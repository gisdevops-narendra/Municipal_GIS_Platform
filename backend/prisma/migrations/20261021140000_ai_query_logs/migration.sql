-- AI Assistant question log + answer feedback.
CREATE TABLE "ai_query_logs" (
    "id" TEXT NOT NULL,
    "municipality_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer_kind" TEXT NOT NULL,
    "planner" TEXT,
    "operation" JSONB,
    "explanation" TEXT,
    "matched" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "error" TEXT,
    "feedback" INTEGER,
    "feedback_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_query_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_query_logs_municipality_id_created_at_idx" ON "ai_query_logs"("municipality_id", "created_at");
