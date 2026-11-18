-- Avoid scanning Pokémon and Energy rows for character-card lookups.
CREATE INDEX IF NOT EXISTS idx_catalogue_trainer_directory
ON catalogue_cards(language, is_active, owner_id, id)
WHERE category = 'trainer';
