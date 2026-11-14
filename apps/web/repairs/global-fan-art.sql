-- Promote only these two verified fan-art printings to the shared catalogue.
-- Run in dev first, then UAT if configured, then production, checking each result.
-- Keep is_custom = 1 so TCGdex refreshes cannot retire these printings.
-- The fan-art source also prevents a user backup restore from claiming a shared card.

INSERT INTO card_sources
  (provider, source_id, card_id, language, source_updated_at, checksum, active, imported_at)
SELECT 'fan-art', card.id, card.id, card.language, unixepoch(), art.sha256, 1, unixepoch()
FROM catalogue_cards card
JOIN art_manifest art ON art.card_id = card.id AND art.variant = 'high'
JOIN art_manifest low ON low.card_id = card.id AND low.variant = 'low'
WHERE card.is_custom = 1 AND card.is_active = 1
  AND card.set_id = 'unofficial-fan-art-055'
  AND card.language = 'en'
  AND (
    (card.id = 'custom_4c705272-b14d-4dfc-adf9-9cfbb8e76f91'
      AND card.name = 'Mimikyu ex (Unofficial fan art)' AND card.number = '052/055')
    OR (card.id = 'custom_f9c57bdb-852c-4cab-9e55-73c79901d4ae'
      AND card.name = 'Snorlax (Batman, Unofficial fan art)' AND card.number = '027/055')
  )
ON CONFLICT(provider, source_id, language) DO NOTHING;

UPDATE catalogue_cards SET owner_id = NULL, updated_at = unixepoch()
WHERE owner_id IS NOT NULL AND is_custom = 1 AND is_active = 1
  AND set_id = 'unofficial-fan-art-055' AND language = 'en'
  AND (
    (id = 'custom_4c705272-b14d-4dfc-adf9-9cfbb8e76f91'
      AND name = 'Mimikyu ex (Unofficial fan art)' AND number = '052/055')
    OR (id = 'custom_f9c57bdb-852c-4cab-9e55-73c79901d4ae'
      AND name = 'Snorlax (Batman, Unofficial fan art)' AND number = '027/055')
  )
  AND EXISTS (
    SELECT 1 FROM card_sources source
    WHERE source.card_id = catalogue_cards.id AND source.provider = 'fan-art'
      AND source.source_id = catalogue_cards.id AND source.language = catalogue_cards.language
      AND source.active = 1
  )
  AND 2 = (
    SELECT COUNT(*) FROM art_manifest art
    WHERE art.card_id = catalogue_cards.id AND art.variant IN ('high', 'low')
  );

-- A good result is exactly two rows: owner_id NULL, is_custom 1, and fan-art source.
SELECT card.id, card.name, card.number, card.owner_id, card.is_custom,
  source.provider, art.sha256 AS high_sha256, low.sha256 AS low_sha256
FROM catalogue_cards card
LEFT JOIN card_sources source ON source.card_id = card.id AND source.provider = 'fan-art'
LEFT JOIN art_manifest art ON art.card_id = card.id AND art.variant = 'high'
LEFT JOIN art_manifest low ON low.card_id = card.id AND low.variant = 'low'
WHERE card.id IN (
  'custom_4c705272-b14d-4dfc-adf9-9cfbb8e76f91',
  'custom_f9c57bdb-852c-4cab-9e55-73c79901d4ae'
)
ORDER BY card.id;
