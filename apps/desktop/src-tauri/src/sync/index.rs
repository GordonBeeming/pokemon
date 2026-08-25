use super::{SourceCardOutcome, SourceCardWork};
use crate::cloud::{ArtManifestEntry, ArtVariant, CatalogueSourceEntry};
use crate::error::{DesktopError, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

pub(super) struct SourceIndex {
    connection: rusqlite::Connection,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LegacySourceIndex {
    cards: BTreeMap<String, IndexedCard>,
}

impl SourceIndex {
    pub(super) fn open(path: &Path) -> Result<Self> {
        let connection = rusqlite::Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            r#"PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS source_cards (
               card_id TEXT PRIMARY KEY NOT NULL,
               provider TEXT NOT NULL,
               source_id TEXT NOT NULL,
               language TEXT NOT NULL,
               source_updated_at INTEGER NOT NULL,
               source_checksum TEXT NOT NULL,
               variants_json TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS remote_manifest (
               card_id TEXT NOT NULL,
               variant TEXT NOT NULL,
               sha256 TEXT NOT NULL,
               bytes INTEGER NOT NULL,
               PRIMARY KEY (card_id, variant)
             );
             CREATE TABLE IF NOT EXISTS source_queue (
               sequence INTEGER PRIMARY KEY NOT NULL,
               card_id TEXT NOT NULL,
               provider TEXT NOT NULL,
               source_id TEXT NOT NULL,
               language TEXT NOT NULL,
               source_updated_at INTEGER NOT NULL,
               source_checksum TEXT NOT NULL
             );"#,
        )?;
        Ok(Self { connection })
    }

    pub(super) fn clear_source_queue(&self) -> Result<()> {
        self.connection.execute("DELETE FROM source_queue", [])?;
        Ok(())
    }

    pub(super) fn stage_source_page(
        &mut self,
        first_sequence: u64,
        entries: &[CatalogueSourceEntry],
    ) -> Result<u64> {
        let transaction = self.connection.transaction()?;
        {
            let mut statement = transaction.prepare(
                r#"INSERT INTO source_queue
                    (sequence, card_id, provider, source_id, language,
                     source_updated_at, source_checksum)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)"#,
            )?;
            for (offset, entry) in entries.iter().enumerate() {
                statement.execute(rusqlite::params![
                    first_sequence.saturating_add(offset as u64),
                    entry.card_id,
                    entry.provider,
                    entry.source_id,
                    entry.language,
                    entry.source_updated_at,
                    entry.source_checksum,
                ])?;
            }
        }
        transaction.commit()?;
        Ok(first_sequence.saturating_add(entries.len() as u64))
    }

    pub(super) fn source_queue_page(
        &self,
        after_sequence: Option<u64>,
        limit: usize,
    ) -> Result<Vec<(u64, CatalogueSourceEntry)>> {
        let mut statement = self.connection.prepare(
            r#"SELECT sequence, card_id, provider, source_id, language,
                 source_updated_at, source_checksum
               FROM source_queue WHERE sequence > ?1 ORDER BY sequence LIMIT ?2"#,
        )?;
        let mut rows = statement.query(rusqlite::params![after_sequence.unwrap_or(0), limit])?;
        let mut entries = Vec::new();
        while let Some(row) = rows.next()? {
            entries.push((
                row.get(0)?,
                CatalogueSourceEntry {
                    card_id: row.get(1)?,
                    provider: row.get(2)?,
                    source_id: row.get(3)?,
                    language: row.get(4)?,
                    source_updated_at: row.get(5)?,
                    source_checksum: row.get(6)?,
                },
            ));
        }
        Ok(entries)
    }

    pub(super) fn load_page_work(
        &self,
        entries: Vec<CatalogueSourceEntry>,
    ) -> Result<Vec<SourceCardWork>> {
        if entries.is_empty() {
            return Ok(Vec::new());
        }
        let card_ids = entries
            .iter()
            .map(|entry| entry.card_id.as_str())
            .collect::<Vec<_>>();
        let card_ids_json = serde_json::to_string(&card_ids)?;
        let mut indexed_cards = HashMap::<String, IndexedCard>::new();
        let mut statement = self.connection.prepare(
            r#"SELECT card_id, provider, source_id, language, source_updated_at,
                 source_checksum, variants_json
               FROM source_cards
               WHERE card_id IN (SELECT value FROM json_each(?1))"#,
        )?;
        let mut rows = statement.query([&card_ids_json])?;
        while let Some(row) = rows.next()? {
            let card_id: String = row.get(0)?;
            let variants_json: String = row.get(6)?;
            indexed_cards.insert(
                card_id,
                IndexedCard {
                    provider: row.get(1)?,
                    source_id: row.get(2)?,
                    language: row.get(3)?,
                    source_updated_at: row.get(4)?,
                    source_checksum: row.get(5)?,
                    variants: serde_json::from_str(&variants_json)?,
                },
            );
        }

        let mut remote_by_card = HashMap::<String, Vec<ArtManifestEntry>>::new();
        let mut statement = self.connection.prepare(
            r#"SELECT card_id, variant, sha256, bytes
               FROM remote_manifest
               WHERE card_id IN (SELECT value FROM json_each(?1))
               ORDER BY card_id, variant"#,
        )?;
        let mut rows = statement.query([&card_ids_json])?;
        while let Some(row) = rows.next()? {
            let card_id: String = row.get(0)?;
            let variant: String = row.get(1)?;
            let variant = match variant.as_str() {
                "high" => ArtVariant::High,
                "low" => ArtVariant::Low,
                _ => {
                    return Err(DesktopError::InvalidCloudResponse(
                        "source index contains an invalid art variant".to_string(),
                    ))
                }
            };
            remote_by_card
                .entry(card_id.clone())
                .or_default()
                .push(ArtManifestEntry {
                    card_id,
                    variant,
                    sha256: row.get(2)?,
                    bytes: row.get(3)?,
                });
        }

        Ok(entries
            .into_iter()
            .map(|source_entry| SourceCardWork {
                indexed: indexed_cards.get(&source_entry.card_id).cloned(),
                remote_entries: remote_by_card
                    .get(&source_entry.card_id)
                    .cloned()
                    .unwrap_or_default(),
                source_entry,
            })
            .collect())
    }

    pub(super) fn apply_source_outcomes(&mut self, outcomes: &[SourceCardOutcome]) -> Result<()> {
        let transaction = self.connection.transaction()?;
        {
            let mut remote = transaction.prepare(
                r#"INSERT INTO remote_manifest (card_id, variant, sha256, bytes)
                   VALUES (?1, ?2, ?3, ?4)
                   ON CONFLICT(card_id, variant) DO UPDATE SET
                     sha256 = excluded.sha256, bytes = excluded.bytes"#,
            )?;
            let mut card = transaction.prepare(
                r#"INSERT INTO source_cards
                    (card_id, provider, source_id, language, source_updated_at,
                     source_checksum, variants_json)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                   ON CONFLICT(card_id) DO UPDATE SET provider = excluded.provider,
                     source_id = excluded.source_id, language = excluded.language,
                     source_updated_at = excluded.source_updated_at,
                     source_checksum = excluded.source_checksum,
                     variants_json = excluded.variants_json"#,
            )?;
            for outcome in outcomes {
                for entry in &outcome.remote_updates {
                    remote.execute(rusqlite::params![
                        entry.card_id,
                        entry.variant.as_str(),
                        entry.sha256,
                        entry.bytes,
                    ])?;
                }
                if let Some((card_id, indexed)) = &outcome.indexed_card {
                    card.execute(rusqlite::params![
                        card_id,
                        indexed.provider,
                        indexed.source_id,
                        indexed.language,
                        indexed.source_updated_at,
                        indexed.source_checksum,
                        serde_json::to_string(&indexed.variants)?,
                    ])?;
                }
            }
        }
        transaction.commit()?;
        Ok(())
    }

    fn insert(&self, card_id: String, card: IndexedCard) -> Result<()> {
        self.connection.execute(
            r#"INSERT INTO source_cards
              (card_id, provider, source_id, language, source_updated_at, source_checksum, variants_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(card_id) DO UPDATE SET provider = excluded.provider,
               source_id = excluded.source_id, language = excluded.language,
               source_updated_at = excluded.source_updated_at,
               source_checksum = excluded.source_checksum,
               variants_json = excluded.variants_json"#,
            rusqlite::params![
                card_id,
                card.provider,
                card.source_id,
                card.language,
                card.source_updated_at,
                card.source_checksum,
                serde_json::to_string(&card.variants)?,
            ],
        )?;
        Ok(())
    }

    pub(super) fn checkpoint(&self) -> Result<()> {
        self.connection
            .execute_batch("PRAGMA wal_checkpoint(PASSIVE);")?;
        Ok(())
    }

    pub(super) fn clear_remote_manifest(&self) -> Result<()> {
        self.connection.execute("DELETE FROM remote_manifest", [])?;
        Ok(())
    }

    pub(super) fn put_remote_entries(&mut self, entries: &[ArtManifestEntry]) -> Result<()> {
        let transaction = self.connection.transaction()?;
        {
            let mut statement = transaction.prepare(
                r#"INSERT INTO remote_manifest (card_id, variant, sha256, bytes)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(card_id, variant) DO UPDATE SET
                   sha256 = excluded.sha256, bytes = excluded.bytes"#,
            )?;
            for entry in entries {
                statement.execute(rusqlite::params![
                    entry.card_id,
                    entry.variant.as_str(),
                    entry.sha256,
                    entry.bytes,
                ])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IndexedCard {
    pub(super) provider: String,
    pub(super) source_id: String,
    pub(super) language: String,
    pub(super) source_updated_at: u64,
    pub(super) source_checksum: String,
    pub(super) variants: BTreeMap<String, IndexedVariant>,
}

impl IndexedCard {
    pub(super) fn matches_source(&self, source: &CatalogueSourceEntry) -> bool {
        self.provider == source.provider
            && self.source_id == source.source_id
            && self.language == source.language
            && self.source_updated_at == source.source_updated_at
            && self.source_checksum == source.source_checksum
    }

    pub(super) fn entry(&self, card_id: &str, variant: ArtVariant) -> Option<ArtManifestEntry> {
        self.variants
            .get(variant.as_str())
            .map(|indexed| ArtManifestEntry {
                card_id: card_id.to_string(),
                variant,
                sha256: indexed.sha256.clone(),
                bytes: indexed.bytes,
            })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct IndexedVariant {
    sha256: String,
    bytes: u64,
}

impl From<&ArtManifestEntry> for IndexedVariant {
    fn from(entry: &ArtManifestEntry) -> Self {
        Self {
            sha256: entry.sha256.clone(),
            bytes: entry.bytes,
        }
    }
}

pub(super) fn load_source_index(path: &Path, legacy_path: &Path) -> Result<SourceIndex> {
    let needs_migration = !path.exists() && legacy_path.exists();
    let index = SourceIndex::open(path)?;
    if needs_migration {
        let legacy: LegacySourceIndex = serde_json::from_slice(&std::fs::read(legacy_path)?)?;
        for (card_id, card) in legacy.cards {
            index.insert(card_id, card)?;
        }
        std::fs::rename(legacy_path, legacy_path.with_extension("json.migrated"))?;
    }
    Ok(index)
}
