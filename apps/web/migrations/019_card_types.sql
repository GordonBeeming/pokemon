-- Elemental typing (TCGdex `types`, e.g. ["Grass"]) drives the card frame colour.
-- Nullable: older imports haven't seen it yet, and the frame renders neutral until
-- the next full catalogue sync backfills it.
ALTER TABLE catalogue_cards ADD COLUMN types TEXT;
ALTER TABLE catalogue_stage_cards ADD COLUMN types TEXT;
