import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { artistKey } from '@pokedex/shared';
import { artistSpellings, preferredArtistName } from './artists';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('artistKey', () => {
  it('gives every spelling TCGdex uses for one illustrator the same key', () => {
    const groups = [
      ['"Big Mama" Tagawa', '"Big Mama" Tagawa"', '"Big Mama" Tagawa"Big Mama" Tagawa'],
      ['Saino Misaki', 'saino misaki'],
      ['aky CG Works', 'akyCG Works'],
      ['Miki Tanaka', 'MikiTanaka'],
      ['Shinji Higuchi + Noriko Takaya', 'Shinji Higuchi + Noriko Takaya 樋口 真嗣 + 高屋 法子'],
      ['Kouki Saitō', 'Kouki Saito'],
    ];
    for (const spellings of groups)
      expect(new Set(spellings.map(artistKey)).size, spellings.join(' | ')).toBe(1);
  });

  it('keeps different illustrators apart, including names written only in Japanese', () => {
    expect(artistKey('Ken Sugimori')).not.toBe(artistKey('Kagemaru Himeno'));
    expect(artistKey('樋口 真嗣')).not.toBe(artistKey('高屋 法子'));
    expect(artistKey('樋口 真嗣')).not.toBe('');
  });
});

describe('preferredArtistName', () => {
  it('shows a capitalised spelling first, then the most used, then the shortest', () => {
    expect(
      preferredArtistName([
        { name: 'takuyoa', cards: 83 },
        { name: 'Takuyoa', cards: 1 },
      ]),
    ).toBe('Takuyoa');
    expect(
      preferredArtistName([
        { name: '"Big Mama" Tagawa"', cards: 1 },
        { name: '"Big Mama" Tagawa', cards: 7 },
        { name: '"Big Mama" Tagawa"Big Mama" Tagawa', cards: 1 },
      ]),
    ).toBe('"Big Mama" Tagawa');
  });
});

describe('artistSpellings', () => {
  it('finds every stored spelling of the illustrator a name belongs to', async () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    applyAllMigrations(database);
    database.exec(`
      INSERT INTO catalogue_cards
        (id, name, language, category, set_id, set_name, number, artist, is_active, is_custom, created_at, updated_at)
      VALUES
        ('a', 'A', 'en', 'pokemon', 's', 'S', '1', 'Saino Misaki', 1, 0, 1, 1),
        ('b', 'B', 'en', 'pokemon', 's', 'S', '2', 'saino misaki', 1, 0, 1, 1),
        ('c', 'C', 'en', 'pokemon', 's', 'S', '3', 'Ken Sugimori', 1, 0, 1, 1);
    `);
    const spellings = await artistSpellings(sqliteD1(database), 'Saino Misaki');
    expect(spellings.slice().sort()).toEqual(['Saino Misaki', 'saino misaki']);
  });
});
