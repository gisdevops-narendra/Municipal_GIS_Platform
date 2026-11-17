-- Share Map links, API keys and webhooks.
CREATE TABLE "gis_share_links" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "municipality_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "config" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "last_viewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gis_share_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gis_share_links_token_key" ON "gis_share_links"("token");
CREATE INDEX "gis_share_links_municipality_id_idx" ON "gis_share_links"("municipality_id");
ALTER TABLE "gis_share_links" ADD CONSTRAINT "gis_share_links_municipality_id_fkey"
    FOREIGN KEY ("municipality_id") REFERENCES "municipalities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "api_keys" (
    "id" TEXT NOT NULL,
    "municipality_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");
CREATE INDEX "api_keys_municipality_id_idx" ON "api_keys"("municipality_id");
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_municipality_id_fkey"
    FOREIGN KEY ("municipality_id") REFERENCES "municipalities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "webhooks" (
    "id" TEXT NOT NULL,
    "municipality_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "last_status" INTEGER,
    "last_error" TEXT,
    "last_delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "webhooks_municipality_id_idx" ON "webhooks"("municipality_id");
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_municipality_id_fkey"
    FOREIGN KEY ("municipality_id") REFERENCES "municipalities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
