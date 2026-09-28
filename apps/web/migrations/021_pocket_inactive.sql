-- PRODUCT.md excludes TCG Pocket, but the importer's old logo/symbol-only check
-- missed sets whose logo didn't resolve, so 444 Pocket cards from A3a/A3b/B1a/B2a
-- (and any future set matching the same id shape) leaked into the catalogue.
-- Hide them (is_active = 0); never delete, since binder slots already reference
-- them (e.g. a Squirtle target in Crimson Blaze/B1a) and must stay intact.
UPDATE catalogue_cards
SET is_active = 0
WHERE is_custom = 0
  AND is_active = 1
  AND (
    set_id GLOB '[AB][0-9]'
    OR set_id GLOB '[AB][0-9][0-9]'
    OR set_id GLOB '[AB][0-9][0-9][0-9]'
    OR set_id GLOB '[AB][0-9][a-z]'
    OR set_id GLOB '[AB][0-9][0-9][a-z]'
    OR set_id GLOB '[AB][0-9][0-9][0-9][a-z]'
  );
