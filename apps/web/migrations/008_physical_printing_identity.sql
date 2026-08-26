CREATE TABLE catalogue_card_merge_map_v8 (
  duplicate_id TEXT PRIMARY KEY NOT NULL,
  keeper_id TEXT NOT NULL
);

INSERT INTO catalogue_card_merge_map_v8 (duplicate_id, keeper_id)
WITH ranked AS (
  SELECT card.id,
    FIRST_VALUE(card.id) OVER printing AS keeper_id,
    ROW_NUMBER() OVER printing AS printing_rank
  FROM catalogue_cards card
  WHERE card.is_custom = 0
  WINDOW printing AS (
    PARTITION BY card.language, lower(card.set_name), card.number, lower(card.name)
    ORDER BY
      EXISTS (
        SELECT 1 FROM collection_cards collection
        WHERE collection.card_id = card.id AND collection.quantity > 0
      ) DESC,
      EXISTS (SELECT 1 FROM binder_slots slot WHERE slot.card_id = card.id) DESC,
      EXISTS (
        SELECT 1 FROM species_representatives representative
        WHERE representative.card_id = card.id
      ) DESC,
      card.created_at,
      card.id
  )
)
SELECT id, keeper_id FROM ranked WHERE printing_rank > 1;

INSERT INTO collection_cards
  (owner_id, card_id, quantity, notes, revision, updated_at)
SELECT collection.owner_id, mapping.keeper_id, collection.quantity, collection.notes,
  collection.revision, collection.updated_at
FROM collection_cards collection
JOIN catalogue_card_merge_map_v8 mapping ON mapping.duplicate_id = collection.card_id
WHERE true
ON CONFLICT(owner_id, card_id) DO UPDATE SET
  quantity = MIN(9999, collection_cards.quantity + excluded.quantity),
  notes = CASE
    WHEN collection_cards.notes IS NULL THEN excluded.notes
    WHEN excluded.notes IS NULL OR excluded.notes = collection_cards.notes THEN collection_cards.notes
    ELSE collection_cards.notes || char(10) || excluded.notes
  END,
  revision = MAX(collection_cards.revision, excluded.revision) + 1,
  updated_at = MAX(collection_cards.updated_at, excluded.updated_at);
DELETE FROM collection_cards
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8);

DELETE FROM collection_mutations
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8);

UPDATE binder_slots
SET card_id = (
  SELECT keeper_id FROM catalogue_card_merge_map_v8 mapping
  WHERE mapping.duplicate_id = binder_slots.card_id
)
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8);

UPDATE species_representatives
SET card_id = (
  SELECT keeper_id FROM catalogue_card_merge_map_v8 mapping
  WHERE mapping.duplicate_id = species_representatives.card_id
)
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8);

DELETE FROM art_manifest
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8)
  AND EXISTS (
    SELECT 1
    FROM catalogue_card_merge_map_v8 mapping
    JOIN art_manifest keeper
      ON keeper.card_id = mapping.keeper_id AND keeper.variant = art_manifest.variant
    WHERE mapping.duplicate_id = art_manifest.card_id
  );
UPDATE art_manifest
SET card_id = (
  SELECT keeper_id FROM catalogue_card_merge_map_v8 mapping
  WHERE mapping.duplicate_id = art_manifest.card_id
)
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8);

UPDATE art_upload_tokens
SET card_id = (
  SELECT keeper_id FROM catalogue_card_merge_map_v8 mapping
  WHERE mapping.duplicate_id = art_upload_tokens.card_id
)
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8);

DELETE FROM price_snapshots
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8)
  AND EXISTS (
    SELECT 1
    FROM catalogue_card_merge_map_v8 mapping
    JOIN price_snapshots keeper
      ON keeper.card_id = mapping.keeper_id
      AND keeper.source = price_snapshots.source
      AND keeper.source_captured_at = price_snapshots.source_captured_at
    WHERE mapping.duplicate_id = price_snapshots.card_id
  );
UPDATE price_snapshots
SET card_id = (
  SELECT keeper_id FROM catalogue_card_merge_map_v8 mapping
  WHERE mapping.duplicate_id = price_snapshots.card_id
)
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8);

DELETE FROM price_stage_rows
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8)
  AND EXISTS (
    SELECT 1
    FROM catalogue_card_merge_map_v8 mapping
    JOIN price_stage_rows keeper
      ON keeper.card_id = mapping.keeper_id
      AND keeper.run_id = price_stage_rows.run_id
      AND keeper.source = price_stage_rows.source
      AND keeper.source_captured_at = price_stage_rows.source_captured_at
    WHERE mapping.duplicate_id = price_stage_rows.card_id
  );
UPDATE price_stage_rows
SET card_id = (
  SELECT keeper_id FROM catalogue_card_merge_map_v8 mapping
  WHERE mapping.duplicate_id = price_stage_rows.card_id
)
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8);

DELETE FROM card_current_prices
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8)
  AND EXISTS (
    SELECT 1 FROM catalogue_card_merge_map_v8 mapping
    JOIN card_current_prices keeper ON keeper.card_id = mapping.keeper_id
    WHERE mapping.duplicate_id = card_current_prices.card_id
  );
UPDATE card_current_prices
SET card_id = (
  SELECT keeper_id FROM catalogue_card_merge_map_v8 mapping
  WHERE mapping.duplicate_id = card_current_prices.card_id
)
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8);

UPDATE catalogue_stage_cards
SET card_id = (
  SELECT keeper_id FROM catalogue_card_merge_map_v8 mapping
  WHERE mapping.duplicate_id = catalogue_stage_cards.card_id
)
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8);

UPDATE card_sources
SET card_id = (
  SELECT keeper_id FROM catalogue_card_merge_map_v8 mapping
  WHERE mapping.duplicate_id = card_sources.card_id
)
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8);

DELETE FROM catalogue_search
WHERE card_id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8);

DELETE FROM catalogue_cards
WHERE id IN (SELECT duplicate_id FROM catalogue_card_merge_map_v8);

CREATE UNIQUE INDEX idx_catalogue_physical_printing
  ON catalogue_cards(language, lower(set_name), number, lower(name))
  WHERE is_custom = 0;

DROP TABLE catalogue_card_merge_map_v8;
