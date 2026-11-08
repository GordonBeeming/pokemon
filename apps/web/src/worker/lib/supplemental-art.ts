/** Rotate unsuccessful cards so a permanently missing scan cannot block the queue. */
export async function supplementalArtCandidates(
  db: D1Database,
  day: number,
): Promise<Array<{ id: string }>> {
  const result = await db
    .prepare(
      `SELECT c.id,
    EXISTS(SELECT 1 FROM collection_cards owned WHERE owned.card_id=c.id AND owned.quantity>0)
      OR EXISTS(SELECT 1 FROM binder_slots slot WHERE slot.card_id=c.id OR slot.assigned_card_id=c.id) AS in_use
    FROM catalogue_cards c WHERE c.language='en' AND c.is_active=1 AND c.owner_id IS NULL
      AND (EXISTS(SELECT 1 FROM card_sources s WHERE s.card_id=c.id AND s.provider='tcgcsv' AND s.active=1)
        OR EXISTS(SELECT 1 FROM collection_cards owned WHERE owned.card_id=c.id AND owned.quantity>0)
        OR EXISTS(SELECT 1 FROM binder_slots slot WHERE slot.card_id=c.id OR slot.assigned_card_id=c.id))
      AND (NOT EXISTS(SELECT 1 FROM art_manifest a WHERE a.card_id=c.id AND a.variant='low')
        OR NOT EXISTS(SELECT 1 FROM art_manifest a WHERE a.card_id=c.id AND a.variant='high'))
    ORDER BY in_use DESC,c.id`,
    )
    .all<{ id: string; in_use: number }>();
  const priority = result.results.filter((c) => c.in_use === 1).slice(0, 20);
  const selected = new Set(priority.map((c) => c.id));
  const remaining = result.results.filter((c) => !selected.has(c.id));
  const offset = remaining.length ? (Math.floor(day) * 40) % remaining.length : 0;
  const rotated = [...remaining.slice(offset), ...remaining.slice(0, offset)];
  return [...priority, ...rotated.slice(0, 60 - priority.length)].map(({ id }) => ({ id }));
}
