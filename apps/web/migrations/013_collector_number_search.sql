CREATE INDEX idx_catalogue_cards_collector_number
ON catalogue_cards (
  ltrim(trim(substr(number, 1, instr(number || '/', '/') - 1)), '0')
)
WHERE is_active = 1;
