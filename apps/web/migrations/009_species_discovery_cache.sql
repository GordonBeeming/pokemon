CREATE TABLE species_discovery_cache (
  pokedex_number INTEGER PRIMARY KEY NOT NULL CHECK (pokedex_number BETWEEN 1 AND 1025),
  species_name TEXT NOT NULL,
  printing_count INTEGER NOT NULL CHECK (printing_count >= 0),
  last_checked_at INTEGER NOT NULL
);

CREATE INDEX idx_species_discovery_cache_checked
  ON species_discovery_cache(last_checked_at);
