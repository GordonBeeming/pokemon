import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import { supplementalArtCandidates } from './supplemental-art';

it('rotates failed images beyond the daily cap while retaining priority for owned cards', async () => {
  const raw = new DatabaseSync(':memory:');
  try {
    applyAllMigrations(raw);
    raw.exec("INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1)");
    const card =
      raw.prepare(`INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,created_at,updated_at)
      VALUES(?,'Pikachu','en','pokemon','test','Test',?,1,1)`);
    const source = raw.prepare(
      "INSERT INTO card_sources(provider,source_id,card_id,language,source_updated_at,checksum,active,imported_at) VALUES('tcgcsv',?,?,'en',1,'checksum',1,1)",
    );
    for (let n = 0; n < 100; n++) {
      const id = `card-${n}`;
      card.run(id, String(n));
      source.run(String(n), id);
    }
    raw.exec(
      "INSERT INTO collection_cards(owner_id,card_id,quantity,updated_at) VALUES('owner','card-99',1,1)",
    );
    const db = sqliteD1(raw);
    const first = await supplementalArtCandidates(db, 0);
    const second = await supplementalArtCandidates(db, 1);
    expect(first).toHaveLength(60);
    expect(second).toHaveLength(60);
    expect(first[0]?.id).toBe('card-99');
    expect(second[0]?.id).toBe('card-99');
    expect(new Set([...first, ...second].map((c) => c.id)).size).toBe(100);
  } finally {
    raw.close();
  }
});
