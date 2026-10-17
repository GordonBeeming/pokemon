-- Turns the Claydol sleeve back into an "any Claydol" Pokémon target (#344).
-- Change target with "Replace with same type" used to rewrite a Pokémon sleeve as an
-- exact-card target and drop the copy placed in it.
--
-- Run from apps/web:
--   pnpm exec wrangler d1 execute DB --remote --config wrangler.jsonc --env-file /dev/null --file repairs/claydol-pokemon-target.sql
--
-- It only changes something when exactly one exact-card sleeve holding a Pokémon #344
-- card exists in owner's draft or active binder versions. With none or several, every
-- update matches nothing and the first result lists what was found.
-- A good result: the first SELECT shows 1 row with entry_kind exact-card; the last
-- SELECT shows that sleeve with entry_kind pokemon, pokemon_number 344, and its
-- card_id null and assigned_card_id set to the printing it showed (or null when no
-- free copy of it is owned).

SELECT b.name AS binder, v.status, p.position + 1 AS page, s.row_index + 1 AS row,
  s.column_index + 1 AS pocket, s.entry_kind, s.card_id, s.assigned_card_id,
  c.set_name, c.number
FROM binder_slots s
JOIN binder_pages p ON p.id = s.binder_page_id
JOIN binder_versions v ON v.id = p.binder_version_id
JOIN binders b ON b.id = v.binder_id
JOIN catalogue_cards c ON c.id = s.card_id
WHERE b.owner_id = 'owner' AND v.status IN ('draft', 'active')
  AND s.entry_kind = 'exact-card' AND c.category = 'pokemon' AND c.pokedex_number = 344;

-- The version and binder are bumped first, while the sleeve still matches, so open
-- tabs reload the binder instead of writing over the repair.
UPDATE binder_versions SET revision = revision + 1
WHERE id = (
    SELECT p.binder_version_id FROM binder_slots s
    JOIN binder_pages p ON p.id = s.binder_page_id
    JOIN binder_versions v ON v.id = p.binder_version_id
    JOIN binders b ON b.id = v.binder_id
    JOIN catalogue_cards c ON c.id = s.card_id
    WHERE b.owner_id = 'owner' AND v.status IN ('draft', 'active')
      AND s.entry_kind = 'exact-card' AND c.category = 'pokemon' AND c.pokedex_number = 344)
  AND (
    SELECT COUNT(*) FROM binder_slots s
    JOIN binder_pages p ON p.id = s.binder_page_id
    JOIN binder_versions v ON v.id = p.binder_version_id
    JOIN binders b ON b.id = v.binder_id
    JOIN catalogue_cards c ON c.id = s.card_id
    WHERE b.owner_id = 'owner' AND v.status IN ('draft', 'active')
      AND s.entry_kind = 'exact-card' AND c.category = 'pokemon' AND c.pokedex_number = 344) = 1;

UPDATE binders SET updated_at = unixepoch()
WHERE id = (
    SELECT v.binder_id FROM binder_slots s
    JOIN binder_pages p ON p.id = s.binder_page_id
    JOIN binder_versions v ON v.id = p.binder_version_id
    JOIN binders b ON b.id = v.binder_id
    JOIN catalogue_cards c ON c.id = s.card_id
    WHERE b.owner_id = 'owner' AND v.status IN ('draft', 'active')
      AND s.entry_kind = 'exact-card' AND c.category = 'pokemon' AND c.pokedex_number = 344)
  AND (
    SELECT COUNT(*) FROM binder_slots s
    JOIN binder_pages p ON p.id = s.binder_page_id
    JOIN binder_versions v ON v.id = p.binder_version_id
    JOIN binders b ON b.id = v.binder_id
    JOIN catalogue_cards c ON c.id = s.card_id
    WHERE b.owner_id = 'owner' AND v.status IN ('draft', 'active')
      AND s.entry_kind = 'exact-card' AND c.category = 'pokemon' AND c.pokedex_number = 344) = 1;

-- A Pokémon sleeve has no card_id of its own, so the printing it was set to becomes the
-- placed copy when owner has one that no active binder already holds; a copy that is
-- still placed here is kept. SET reads the old row, so card_id below is the printing.
UPDATE binder_slots
SET entry_kind = 'pokemon', pokemon_number = 344, card_id = NULL,
  assigned_card_id = COALESCE(assigned_card_id, CASE WHEN
    COALESCE((SELECT quantity FROM collection_cards
      WHERE owner_id = 'owner' AND card_id = binder_slots.card_id), 0) >
    (SELECT COUNT(*) FROM binder_slots placed
      JOIN binder_pages pp ON pp.id = placed.binder_page_id
      JOIN binder_versions pv ON pv.id = pp.binder_version_id
      JOIN binders pb ON pb.id = pv.binder_id
      WHERE pb.owner_id = 'owner' AND pv.status = 'active'
        AND placed.assigned_card_id = binder_slots.card_id)
    THEN card_id END)
WHERE (binder_page_id, row_index, column_index) IN (
    SELECT s.binder_page_id, s.row_index, s.column_index FROM binder_slots s
    JOIN binder_pages p ON p.id = s.binder_page_id
    JOIN binder_versions v ON v.id = p.binder_version_id
    JOIN binders b ON b.id = v.binder_id
    JOIN catalogue_cards c ON c.id = s.card_id
    WHERE b.owner_id = 'owner' AND v.status IN ('draft', 'active')
      AND s.entry_kind = 'exact-card' AND c.category = 'pokemon' AND c.pokedex_number = 344)
  AND (
    SELECT COUNT(*) FROM binder_slots s
    JOIN binder_pages p ON p.id = s.binder_page_id
    JOIN binder_versions v ON v.id = p.binder_version_id
    JOIN binders b ON b.id = v.binder_id
    JOIN catalogue_cards c ON c.id = s.card_id
    WHERE b.owner_id = 'owner' AND v.status IN ('draft', 'active')
      AND s.entry_kind = 'exact-card' AND c.category = 'pokemon' AND c.pokedex_number = 344) = 1;

SELECT b.name AS binder, v.status, v.revision, p.position + 1 AS page, s.row_index + 1 AS row,
  s.column_index + 1 AS pocket, s.entry_kind, s.pokemon_number, s.card_id, s.assigned_card_id
FROM binder_slots s
JOIN binder_pages p ON p.id = s.binder_page_id
JOIN binder_versions v ON v.id = p.binder_version_id
JOIN binders b ON b.id = v.binder_id
WHERE b.owner_id = 'owner' AND v.status IN ('draft', 'active') AND s.pokemon_number = 344;
