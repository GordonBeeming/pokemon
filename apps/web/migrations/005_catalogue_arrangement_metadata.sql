ALTER TABLE catalogue_cards ADD COLUMN release_date TEXT;
ALTER TABLE catalogue_cards ADD COLUMN pokedex_number INTEGER;
ALTER TABLE catalogue_stage_cards ADD COLUMN release_date TEXT;
ALTER TABLE catalogue_stage_cards ADD COLUMN pokedex_number INTEGER;
CREATE INDEX IF NOT EXISTS idx_catalogue_cards_release_date ON catalogue_cards(release_date);
CREATE INDEX IF NOT EXISTS idx_catalogue_cards_pokedex_number ON catalogue_cards(pokedex_number);
