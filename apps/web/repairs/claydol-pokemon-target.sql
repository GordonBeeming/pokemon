-- Turns the Claydol sleeve back into an "any Claydol" Pokémon target (#344).
-- Change target with "Replace with same type" used to rewrite a Pokémon sleeve as an
-- exact-card target and drop the copy placed in it.
--
-- Run from apps/web. Wrangler prints only counts for --file, so check the sleeve with
-- --command before and after:
--   pnpm exec wrangler d1 execute DB --remote --config wrangler.jsonc --env-file /dev/null --command "SELECT b.name, v.status, p.position + 1 AS page, s.row_index + 1 AS row, s.column_index + 1 AS pocket, s.entry_kind, s.pokemon_number, s.card_id, s.assigned_card_id FROM binder_slots s JOIN binder_pages p ON p.id = s.binder_page_id JOIN binder_versions v ON v.id = p.binder_version_id JOIN binders b ON b.id = v.binder_id LEFT JOIN catalogue_cards c ON c.id = s.card_id WHERE b.owner_id = 'owner' AND v.status IN ('draft', 'active') AND (s.pokemon_number = 344 OR (s.entry_kind = 'exact-card' AND c.pokedex_number = 344))"
--   pnpm exec wrangler d1 execute DB --remote --config wrangler.jsonc --env-file /dev/null --file repairs/claydol-pokemon-target.sql
--
-- It only changes something when exactly one exact-card sleeve holding a Pokémon #344
-- card exists in owner's draft or active binder versions. With none or several, every
-- update matches nothing.
-- A good result: before, the check shows that sleeve as exact-card; after, the same
-- sleeve shows entry_kind pokemon, pokemon_number 344, card_id null, and
-- assigned_card_id set to the printing it showed (or null when no free copy is owned).

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
-- placed copy when owner has a free one, counted the way the app counts placements: this
-- version plus every other binder's active version. A copy still placed here is kept.
-- SET reads the old row, so card_id below is the printing.
UPDATE binder_slots
SET entry_kind = 'pokemon', pokemon_number = 344, card_id = NULL,
  assigned_card_id = COALESCE(assigned_card_id, CASE WHEN
    COALESCE((SELECT quantity FROM collection_cards
      WHERE owner_id = 'owner' AND card_id = binder_slots.card_id), 0) >
    (SELECT COUNT(*) FROM binder_slots placed
      JOIN binder_pages pp ON pp.id = placed.binder_page_id
      JOIN binder_versions pv ON pv.id = pp.binder_version_id
      JOIN binders pb ON pb.id = pv.binder_id
      JOIN binder_pages here_page ON here_page.id = binder_slots.binder_page_id
      JOIN binder_versions here ON here.id = here_page.binder_version_id
      WHERE pb.owner_id = 'owner'
        AND placed.assigned_card_id = binder_slots.card_id
        AND NOT (placed.binder_page_id = binder_slots.binder_page_id
          AND placed.row_index = binder_slots.row_index
          AND placed.column_index = binder_slots.column_index)
        AND (pv.id = here.id OR (pv.status = 'active'
          AND NOT (here.status = 'draft' AND pv.binder_id = here.binder_id))))
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
