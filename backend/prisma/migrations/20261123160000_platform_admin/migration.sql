-- Platform admin: settings (branding, announcement, maintenance, modules,
-- email), last sign-in per user, daily active users and tool usage.
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "users" ADD COLUMN "last_seen_at" TIMESTAMP(3);

CREATE TABLE "user_activity_days" (
    "day" DATE NOT NULL,
    "user_id" TEXT NOT NULL,
    CONSTRAINT "user_activity_days_pkey" PRIMARY KEY ("day", "user_id")
);

CREATE TABLE "tool_usage_days" (
    "day" DATE NOT NULL,
    "tool" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "tool_usage_days_pkey" PRIMARY KEY ("day", "tool")
);
