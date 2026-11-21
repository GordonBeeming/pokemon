-- Custom creation used to discard dex metadata. Recover only exact species-name
-- matches with one unambiguous dex number in the imported catalogue. Also
-- recognize an imported card name before a parenthetical fan-art label. Unknown
-- species and existing explicit numbers stay untouched; ownership never changes.
WITH species_numbers AS (
  SELECT lower(trim(name)) AS species_name, MIN(pokedex_number) AS dex
  FROM catalogue_cards
  WHERE is_custom = 0 AND category = 'pokemon'
    AND pokedex_number BETWEEN 1 AND 1025
  GROUP BY lower(trim(name))
  HAVING COUNT(DISTINCT pokedex_number) = 1
)
UPDATE catalogue_cards
SET pokedex_number = COALESCE((
  SELECT dex FROM species_numbers
  WHERE species_name = lower(trim(catalogue_cards.species))
), (
  SELECT dex FROM species_numbers
  WHERE species_name = lower(trim(substr(catalogue_cards.name, 1,
    instr(catalogue_cards.name || ' (', ' (') - 1)))
))
WHERE is_custom = 1 AND category = 'pokemon' AND pokedex_number IS NULL
  AND EXISTS (
    SELECT 1 FROM species_numbers
    WHERE species_name = lower(trim(catalogue_cards.species))
      OR species_name = lower(trim(substr(catalogue_cards.name, 1,
        instr(catalogue_cards.name || ' (', ' (') - 1)))
  );
