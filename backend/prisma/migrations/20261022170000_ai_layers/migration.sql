-- AI Assistant: layers saved from an answer are flagged so the Layers panel
-- lists them in their own "AI Assistant" group. Layers saved before this
-- flag existed are recognised by the description the save always wrote.
ALTER TABLE "gis_layers" ADD COLUMN "ai_generated" BOOLEAN NOT NULL DEFAULT false;
UPDATE "gis_layers" SET "ai_generated" = true WHERE "description" LIKE 'Saved from the AI Assistant%';
