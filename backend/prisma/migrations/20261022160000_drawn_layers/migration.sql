-- Draw & Mark: layers created from scratch there are flagged so the two
-- editing tools stay separate (Draw & Mark manages its own layers; Edit
-- Features edits every other existing layer). Everything existing is not
-- drawn.
ALTER TABLE "gis_layers" ADD COLUMN "drawn_layer" BOOLEAN NOT NULL DEFAULT false;
