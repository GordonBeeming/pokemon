use crate::cloud::{
    ArtManifestEntry, ArtManifestPage, ArtVariant, CatalogueSourceEntry, CatalogueSourcePage,
    CloudClient, DownloadMode, UploadTicket,
};
use crate::config::write_private;
use crate::error::{DesktopError, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, RwLock};
use url::Url;

#[async_trait]
pub trait ArtRemote: Send + Sync {
    async fn manifest_page(&self, cursor: Option<&str>) -> Result<ArtManifestPage>;
    async fn catalogue_source_page(&self, cursor: Option<&str>) -> Result<CatalogueSourcePage>;
    async fn download_to(
        &self,
        entry: &ArtManifestEntry,
        start: u64,
        destination: &Path,
    ) -> Result<DownloadMode>;
    async fn issue_upload_ticket(&self, entry: &ArtManifestEntry) -> Result<UploadTicket>;
    async fn upload(&self, ticket: &UploadTicket, bytes: Vec<u8>) -> Result<()>;
}

#[async_trait]
pub trait CardArtSource: Send + Sync {
    async fn image_base(&self, source: &CatalogueSourceEntry) -> Result<Option<Url>>;
    async fn download_to(
        &self,
        image_base: &Url,
        variant: ArtVariant,
        start: u64,
        destination: &Path,
    ) -> Result<DownloadMode>;
}

pub struct TcgdexArtSource {
    http: reqwest::Client,
    api_base: Url,
    language_cards: RwLock<HashMap<String, Arc<HashMap<String, Option<Url>>>>>,
    detail_fallbacks: Mutex<HashMap<String, u16>>,
}

const MAX_DETAIL_FALLBACKS_PER_LANGUAGE: u16 = 100;
const INDEX_CHECKPOINT_CARDS: usize = 250;

impl TcgdexArtSource {
    pub fn new() -> Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("pokedex-desktop/", env!("CARGO_PKG_VERSION")))
                .build()?,
            api_base: Url::parse("https://api.tcgdex.net/v2/")?,
            language_cards: RwLock::new(HashMap::new()),
            detail_fallbacks: Mutex::new(HashMap::new()),
        })
    }

    fn image_url(image_base: &Url, variant: ArtVariant) -> Result<Url> {
        validate_tcgdex_asset_url(image_base)?;
        let mut value = image_base.as_str().trim_end_matches('/').to_string();
        value.push('/');
        value.push_str(variant.as_str());
        value.push_str(".webp");
        let url = Url::parse(&value)?;
        validate_tcgdex_asset_url(&url)?;
        Ok(url)
    }

    async fn language_cards(&self, language: &str) -> Result<Arc<HashMap<String, Option<Url>>>> {
        if let Some(cards) = self.language_cards.read().await.get(language) {
            return Ok(Arc::clone(cards));
        }
        let path = format!("{}/cards", utf8_percent_encode(language, NON_ALPHANUMERIC));
        let response = self.http.get(self.api_base.join(&path)?).send().await?;
        if !response.status().is_success() {
            return Err(DesktopError::InvalidCloudResponse(format!(
                "TCGdex card list request failed with status {}",
                response.status().as_u16()
            )));
        }
        let cards: Vec<TcgdexCardBrief> = response.json().await?;
        let mut indexed = HashMap::with_capacity(cards.len());
        for card in cards {
            let image = match card.image {
                Some(image) => {
                    let url = Url::parse(&image)?;
                    validate_tcgdex_asset_url(&url)?;
                    Some(url)
                }
                None => None,
            };
            indexed.insert(card.id, image);
        }
        let indexed = Arc::new(indexed);
        self.language_cards
            .write()
            .await
            .insert(language.to_string(), Arc::clone(&indexed));
        Ok(indexed)
    }

    async fn detail_fallback_allowed(&self, language: &str) -> bool {
        let mut counts = self.detail_fallbacks.lock().await;
        let count = counts.entry(language.to_string()).or_default();
        if *count >= MAX_DETAIL_FALLBACKS_PER_LANGUAGE {
            return false;
        }
        *count += 1;
        true
    }
}

#[derive(Debug, Deserialize)]
struct TcgdexCard {
    id: String,
    image: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TcgdexCardBrief {
    id: String,
    image: Option<String>,
}

#[async_trait]
impl CardArtSource for TcgdexArtSource {
    async fn image_base(&self, source: &CatalogueSourceEntry) -> Result<Option<Url>> {
        validate_source_entry(source)?;
        let cards = self.language_cards(&source.language).await?;
        if let Some(Some(image)) = cards.get(&source.source_id) {
            return Ok(Some(image.clone()));
        }
        if !self.detail_fallback_allowed(&source.language).await {
            return Ok(None);
        }
        let path = format!(
            "{}/cards/{}",
            utf8_percent_encode(&source.language, NON_ALPHANUMERIC),
            utf8_percent_encode(&source.source_id, NON_ALPHANUMERIC)
        );
        let response = self.http.get(self.api_base.join(&path)?).send().await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(DesktopError::InvalidCloudResponse(format!(
                "TCGdex card request failed with status {}",
                response.status().as_u16()
            )));
        }
        let card: TcgdexCard = response.json().await?;
        if card.id != source.source_id {
            return Err(DesktopError::InvalidCloudResponse(
                "TCGdex returned a different card identifier".to_string(),
            ));
        }
        match card.image {
            Some(image) => {
                let url = Url::parse(&image)?;
                validate_tcgdex_asset_url(&url)?;
                Ok(Some(url))
            }
            None => Ok(None),
        }
    }

    async fn download_to(
        &self,
        image_base: &Url,
        variant: ArtVariant,
        start: u64,
        destination: &Path,
    ) -> Result<DownloadMode> {
        let mut request = self.http.get(Self::image_url(image_base, variant)?);
        if start > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={start}-"));
        }
        let response = request.send().await?;
        if response.status() != reqwest::StatusCode::OK
            && response.status() != reqwest::StatusCode::PARTIAL_CONTENT
        {
            return Err(DesktopError::InvalidCloudResponse(format!(
                "TCGdex {} art request failed with status {}",
                variant.as_str(),
                response.status().as_u16()
            )));
        }
        let resumed = start > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
        let mut options = tokio::fs::OpenOptions::new();
        options.create(true).write(true);
        if resumed {
            options.append(true);
        } else {
            options.truncate(true);
        }
        let mut file = options.open(destination).await?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            file.write_all(&chunk?).await?;
        }
        file.flush().await?;
        file.sync_all().await?;
        Ok(if resumed {
            DownloadMode::Resumed
        } else {
            DownloadMode::Restarted
        })
    }
}

pub struct CloudArtRemote {
    client: CloudClient,
    base_url: String,
    token: String,
}

impl CloudArtRemote {
    pub fn new(client: CloudClient, base_url: String, token: String) -> Self {
        Self {
            client,
            base_url,
            token,
        }
    }
}

#[async_trait]
impl ArtRemote for CloudArtRemote {
    async fn manifest_page(&self, cursor: Option<&str>) -> Result<ArtManifestPage> {
        self.client
            .manifest_page(&self.base_url, &self.token, cursor)
            .await
    }

    async fn catalogue_source_page(&self, cursor: Option<&str>) -> Result<CatalogueSourcePage> {
        self.client
            .catalogue_source_page(&self.base_url, &self.token, cursor)
            .await
    }

    async fn download_to(
        &self,
        entry: &ArtManifestEntry,
        start: u64,
        destination: &Path,
    ) -> Result<DownloadMode> {
        self.client
            .download_art_to(&self.base_url, &self.token, entry, start, destination)
            .await
    }

    async fn issue_upload_ticket(&self, entry: &ArtManifestEntry) -> Result<UploadTicket> {
        self.client
            .issue_upload_ticket(&self.base_url, &self.token, entry)
            .await
    }

    async fn upload(&self, ticket: &UploadTicket, bytes: Vec<u8>) -> Result<()> {
        self.client.upload_art(&self.base_url, ticket, bytes).await
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub manifest_entries: u64,
    pub source_cards: u64,
    pub downloaded: u64,
    pub resumed: u64,
    pub skipped: u64,
    pub bytes_written: u64,
    pub uploaded: u64,
    pub missing_images: u64,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UploadOutcome {
    Uploaded,
    AlreadyPresent,
}

pub struct ArtSyncEngine {
    root: PathBuf,
    remote: Arc<dyn ArtRemote>,
    source: Option<Arc<dyn CardArtSource>>,
}

impl ArtSyncEngine {
    pub fn new(root: PathBuf, remote: Arc<dyn ArtRemote>) -> Self {
        Self {
            root,
            remote,
            source: None,
        }
    }

    pub fn with_source(
        root: PathBuf,
        remote: Arc<dyn ArtRemote>,
        source: Arc<dyn CardArtSource>,
    ) -> Self {
        Self {
            root,
            remote,
            source: Some(source),
        }
    }

    pub async fn synchronize(&self) -> Result<SyncReport> {
        validate_library_path(&self.root)?;
        tokio::fs::create_dir_all(&self.root).await?;
        if let Some(source) = self.source.as_ref() {
            return self.synchronize_sources(source).await;
        }
        self.synchronize_remote_manifest().await
    }

    async fn synchronize_remote_manifest(&self) -> Result<SyncReport> {
        let manifest = self.full_manifest().await?;
        let mut report = SyncReport {
            manifest_entries: manifest.len() as u64,
            ..SyncReport::default()
        };
        for entry in manifest {
            let outcome = self.synchronize_entry(&entry).await?;
            match outcome {
                EntryOutcome::Downloaded { bytes, resumed } => {
                    report.downloaded += 1;
                    report.bytes_written += bytes;
                    if resumed {
                        report.resumed += 1;
                    }
                }
                EntryOutcome::Skipped => report.skipped += 1,
            }
        }
        Ok(report)
    }

    async fn synchronize_sources(&self, source: &Arc<dyn CardArtSource>) -> Result<SyncReport> {
        let manifest = self.full_manifest().await?;
        let mut remote_entries = manifest
            .iter()
            .cloned()
            .map(|entry| (manifest_key(&entry.card_id, entry.variant), entry))
            .collect::<BTreeMap<_, _>>();
        let sources = self.full_source_catalogue().await?;
        let index_path = self.root.join("source-index.json");
        let mut index = load_source_index(&index_path)?;
        let mut report = SyncReport {
            manifest_entries: manifest.len() as u64,
            source_cards: sources.len() as u64,
            ..SyncReport::default()
        };
        let mut cards_since_checkpoint = 0_usize;

        for source_entry in sources {
            validate_source_entry(&source_entry)?;
            let indexed = index.cards.get(&source_entry.card_id).cloned();
            if indexed
                .as_ref()
                .is_some_and(|card| card.matches_source(&source_entry))
            {
                let mut restored = true;
                for variant in [ArtVariant::High, ArtVariant::Low] {
                    let Some(expected) = indexed
                        .as_ref()
                        .and_then(|card| card.entry(&source_entry.card_id, variant))
                    else {
                        restored = false;
                        break;
                    };
                    let Some(remote) =
                        remote_entries.get(&manifest_key(&source_entry.card_id, variant))
                    else {
                        restored = false;
                        break;
                    };
                    if remote != &expected {
                        restored = false;
                        break;
                    }
                    match self.synchronize_entry(remote).await? {
                        EntryOutcome::Downloaded { bytes, resumed } => {
                            report.downloaded += 1;
                            report.bytes_written += bytes;
                            if resumed {
                                report.resumed += 1;
                            }
                        }
                        EntryOutcome::Skipped => report.skipped += 1,
                    }
                }
                if restored {
                    continue;
                }
            }

            let Some(image_base) = source.image_base(&source_entry).await? else {
                report.missing_images += 1;
                continue;
            };
            let mut indexed_variants = BTreeMap::new();
            for variant in [ArtVariant::High, ArtVariant::Low] {
                let (entry, resumed) = self
                    .download_source_variant(source, &source_entry, &image_base, variant)
                    .await?;
                report.downloaded += 1;
                report.bytes_written += entry.bytes;
                if resumed {
                    report.resumed += 1;
                }
                let key = manifest_key(&entry.card_id, entry.variant);
                if remote_entries.get(&key) == Some(&entry) {
                    report.skipped += 1;
                } else {
                    let ticket = self.remote.issue_upload_ticket(&entry).await?;
                    let bytes = tokio::fs::read(local_art_path(&self.root, &entry)).await?;
                    self.remote.upload(&ticket, bytes).await?;
                    report.uploaded += 1;
                    remote_entries.insert(key, entry.clone());
                }
                indexed_variants.insert(variant.as_str().to_string(), IndexedVariant::from(&entry));
            }
            index.cards.insert(
                source_entry.card_id.clone(),
                IndexedCard {
                    provider: source_entry.provider,
                    source_id: source_entry.source_id,
                    language: source_entry.language,
                    source_updated_at: source_entry.source_updated_at,
                    source_checksum: source_entry.source_checksum,
                    variants: indexed_variants,
                },
            );
            cards_since_checkpoint += 1;
            if cards_since_checkpoint >= INDEX_CHECKPOINT_CARDS {
                save_source_index(&index_path, &index)?;
                cards_since_checkpoint = 0;
            }
        }
        save_source_index(&index_path, &index)?;
        Ok(report)
    }

    async fn full_source_catalogue(&self) -> Result<Vec<CatalogueSourceEntry>> {
        let mut entries = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = self.remote.catalogue_source_page(cursor.as_deref()).await?;
            entries.extend(page.entries);
            match page.cursor {
                Some(next) if cursor.as_deref() != Some(next.as_str()) => cursor = Some(next),
                Some(_) => {
                    return Err(DesktopError::InvalidCloudResponse(
                        "catalogue source cursor did not advance".to_string(),
                    ))
                }
                None => break,
            }
        }
        Ok(entries)
    }

    async fn download_source_variant(
        &self,
        source: &Arc<dyn CardArtSource>,
        source_entry: &CatalogueSourceEntry,
        image_base: &Url,
        variant: ArtVariant,
    ) -> Result<(ArtManifestEntry, bool)> {
        let placeholder = ArtManifestEntry {
            card_id: source_entry.card_id.clone(),
            variant,
            sha256: "0".repeat(64),
            bytes: 1,
        };
        let destination = local_art_path(&self.root, &placeholder);
        let parent = destination
            .parent()
            .ok_or_else(|| DesktopError::InvalidPath(destination.clone()))?;
        tokio::fs::create_dir_all(parent).await?;
        let part = destination.with_extension("webp.source.part");
        let mut start = tokio::fs::metadata(&part)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if start > 15 * 1024 * 1024 {
            tokio::fs::remove_file(&part).await?;
            start = 0;
        }
        let mode = source
            .download_to(image_base, variant, start, &part)
            .await?;
        let bytes = tokio::fs::read(&part).await?;
        if bytes.is_empty() || bytes.len() > 15 * 1024 * 1024 || !is_webp(&bytes) {
            tokio::fs::remove_file(&part).await?;
            return Err(DesktopError::InvalidImage(format!(
                "TCGdex {}/{} did not return a valid WebP image",
                source_entry.source_id,
                variant.as_str()
            )));
        }
        let entry = ArtManifestEntry {
            card_id: source_entry.card_id.clone(),
            variant,
            sha256: sha256_bytes(&bytes),
            bytes: bytes.len() as u64,
        };
        if destination.exists() {
            tokio::fs::remove_file(&destination).await?;
        }
        tokio::fs::rename(part, destination).await?;
        Ok((entry, mode == DownloadMode::Resumed))
    }

    pub async fn upload_local(
        &self,
        card_id: &str,
        variant: ArtVariant,
        path: &Path,
    ) -> Result<UploadOutcome> {
        validate_library_path(&self.root)?;
        let bytes = tokio::fs::read(path).await?;
        if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
            return Err(DesktopError::InvalidImage(
                "art uploads must be WebP files".to_string(),
            ));
        }
        let entry = ArtManifestEntry {
            card_id: card_id.to_string(),
            variant,
            sha256: sha256_bytes(&bytes),
            bytes: bytes.len() as u64,
        };
        if self
            .full_manifest()
            .await?
            .iter()
            .any(|remote| remote == &entry)
        {
            return Ok(UploadOutcome::AlreadyPresent);
        }
        let ticket = self.remote.issue_upload_ticket(&entry).await?;
        self.remote.upload(&ticket, bytes).await?;
        Ok(UploadOutcome::Uploaded)
    }

    async fn full_manifest(&self) -> Result<Vec<ArtManifestEntry>> {
        let mut entries = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = self.remote.manifest_page(cursor.as_deref()).await?;
            entries.extend(page.entries);
            match page.cursor {
                Some(next) if cursor.as_deref() != Some(next.as_str()) => cursor = Some(next),
                Some(_) => {
                    return Err(DesktopError::InvalidCloudResponse(
                        "art manifest cursor did not advance".to_string(),
                    ))
                }
                None => break,
            }
        }
        Ok(entries)
    }

    async fn synchronize_entry(&self, entry: &ArtManifestEntry) -> Result<EntryOutcome> {
        validate_manifest_entry(entry)?;
        let destination = local_art_path(&self.root, entry);
        if file_matches(&destination, entry).await? {
            return Ok(EntryOutcome::Skipped);
        }
        let parent = destination
            .parent()
            .ok_or_else(|| DesktopError::InvalidPath(destination.clone()))?;
        tokio::fs::create_dir_all(parent).await?;
        let part = destination.with_extension("webp.part");
        let mut start = tokio::fs::metadata(&part)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if start > entry.bytes {
            tokio::fs::remove_file(&part).await?;
            start = 0;
        }
        let mode = self.remote.download_to(entry, start, &part).await?;
        let actual_bytes = tokio::fs::metadata(&part).await?.len();
        if actual_bytes != entry.bytes {
            return Err(DesktopError::InvalidCloudResponse(format!(
                "download for {}/{} stopped at {actual_bytes} of {} bytes",
                entry.card_id,
                entry.variant.as_str(),
                entry.bytes
            )));
        }
        let actual_hash = sha256_file(&part).await?;
        if actual_hash != entry.sha256 {
            tokio::fs::remove_file(&part).await?;
            return Err(DesktopError::ChecksumMismatch {
                card_id: entry.card_id.clone(),
                variant: entry.variant.as_str().to_string(),
            });
        }
        if destination.exists() {
            tokio::fs::remove_file(&destination).await?;
        }
        tokio::fs::rename(&part, &destination).await?;
        Ok(EntryOutcome::Downloaded {
            bytes: entry.bytes,
            resumed: mode == DownloadMode::Resumed,
        })
    }
}

enum EntryOutcome {
    Downloaded { bytes: u64, resumed: bool },
    Skipped,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SourceIndex {
    cards: BTreeMap<String, IndexedCard>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexedCard {
    provider: String,
    source_id: String,
    language: String,
    source_updated_at: u64,
    source_checksum: String,
    variants: BTreeMap<String, IndexedVariant>,
}

impl IndexedCard {
    fn matches_source(&self, source: &CatalogueSourceEntry) -> bool {
        self.provider == source.provider
            && self.source_id == source.source_id
            && self.language == source.language
            && self.source_updated_at == source.source_updated_at
            && self.source_checksum == source.source_checksum
    }

    fn entry(&self, card_id: &str, variant: ArtVariant) -> Option<ArtManifestEntry> {
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
struct IndexedVariant {
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

fn load_source_index(path: &Path) -> Result<SourceIndex> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(SourceIndex::default()),
        Err(error) => Err(error.into()),
    }
}

fn save_source_index(path: &Path, index: &SourceIndex) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    write_private(&temporary, &serde_json::to_vec_pretty(index)?)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

fn manifest_key(card_id: &str, variant: ArtVariant) -> String {
    format!("{card_id}|{}", variant.as_str())
}

fn validate_source_entry(source: &CatalogueSourceEntry) -> Result<()> {
    const LANGUAGES: [&str; 18] = [
        "en", "fr", "es", "es-mx", "it", "pt", "pt-br", "pt-pt", "de", "nl", "pl", "ru", "ja",
        "ko", "zh-tw", "id", "th", "zh-cn",
    ];
    if source.provider != "tcgdex"
        || source.card_id.trim().is_empty()
        || source.source_id.trim().is_empty()
        || !LANGUAGES.contains(&source.language.as_str())
        || source.source_checksum.len() != 64
        || !source
            .source_checksum
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(DesktopError::InvalidCloudResponse(
            "catalogue source contains an invalid TCGdex reference".to_string(),
        ));
    }
    Ok(())
}

fn validate_tcgdex_asset_url(url: &Url) -> Result<()> {
    if url.scheme() != "https" || url.host_str() != Some("assets.tcgdex.net") {
        return Err(DesktopError::InvalidCloudResponse(
            "TCGdex returned an untrusted image origin".to_string(),
        ));
    }
    Ok(())
}

fn is_webp(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
}

fn validate_manifest_entry(entry: &ArtManifestEntry) -> Result<()> {
    if entry.card_id.trim().is_empty()
        || entry.bytes == 0
        || entry.bytes > 15 * 1024 * 1024
        || entry.sha256.len() != 64
        || !entry.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(DesktopError::InvalidCloudResponse(
            "art manifest contains an invalid entry".to_string(),
        ));
    }
    Ok(())
}

pub fn local_art_path(root: &Path, entry: &ArtManifestEntry) -> PathBuf {
    let safe_card_id = utf8_percent_encode(&entry.card_id, NON_ALPHANUMERIC).to_string();
    root.join("cards")
        .join(safe_card_id)
        .join(format!("{}.webp", entry.variant.as_str()))
}

pub fn validate_library_path(root: &Path) -> Result<()> {
    if !root.is_absolute() {
        return Err(DesktopError::InvalidPath(root.to_path_buf()));
    }
    Ok(())
}

async fn file_matches(path: &Path, entry: &ArtManifestEntry) -> Result<bool> {
    let metadata = match tokio::fs::metadata(path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if metadata.len() != entry.bytes {
        return Ok(false);
    }
    Ok(sha256_file(path).await? == entry.sha256)
}

async fn sha256_file(path: &Path) -> Result<String> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::routing::get;
    use axum::{Json, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;
    use tempfile::tempdir;

    struct MockRemote {
        payload: Vec<u8>,
        entry: ArtManifestEntry,
        fail_first: StdMutex<bool>,
        starts: StdMutex<Vec<u64>>,
        tickets: StdMutex<u32>,
        uploads: StdMutex<u32>,
    }

    #[async_trait]
    impl ArtRemote for MockRemote {
        async fn manifest_page(&self, _cursor: Option<&str>) -> Result<ArtManifestPage> {
            Ok(ArtManifestPage {
                entries: vec![self.entry.clone()],
                cursor: None,
            })
        }

        async fn catalogue_source_page(
            &self,
            _cursor: Option<&str>,
        ) -> Result<CatalogueSourcePage> {
            Ok(CatalogueSourcePage {
                entries: Vec::new(),
                cursor: None,
            })
        }

        async fn download_to(
            &self,
            _entry: &ArtManifestEntry,
            start: u64,
            destination: &Path,
        ) -> Result<DownloadMode> {
            self.starts.lock().expect("starts").push(start);
            let mut options = std::fs::OpenOptions::new();
            options.create(true).write(true);
            if start > 0 {
                options.append(true);
            } else {
                options.truncate(true);
            }
            use std::io::Write;
            let mut file = options.open(destination)?;
            if *self.fail_first.lock().expect("fail flag") {
                *self.fail_first.lock().expect("fail flag") = false;
                file.write_all(&self.payload[..self.payload.len() / 2])?;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionReset,
                    "interrupted",
                )
                .into());
            }
            file.write_all(&self.payload[start as usize..])?;
            Ok(if start > 0 {
                DownloadMode::Resumed
            } else {
                DownloadMode::Restarted
            })
        }

        async fn issue_upload_ticket(&self, _entry: &ArtManifestEntry) -> Result<UploadTicket> {
            *self.tickets.lock().expect("tickets") += 1;
            Ok(UploadTicket {
                token: "ticket".to_string(),
                upload_path: "/upload".to_string(),
            })
        }

        async fn upload(&self, _ticket: &UploadTicket, _bytes: Vec<u8>) -> Result<()> {
            *self.uploads.lock().expect("uploads") += 1;
            Ok(())
        }
    }

    fn webp() -> Vec<u8> {
        b"RIFF\x10\x00\x00\x00WEBPtest-payload".to_vec()
    }

    fn remote(payload: Vec<u8>, hash: Option<String>, fail_first: bool) -> Arc<MockRemote> {
        let entry = ArtManifestEntry {
            card_id: "card/../safe".to_string(),
            variant: ArtVariant::High,
            sha256: hash.unwrap_or_else(|| sha256_bytes(&payload)),
            bytes: payload.len() as u64,
        };
        Arc::new(MockRemote {
            payload,
            entry,
            fail_first: StdMutex::new(fail_first),
            starts: StdMutex::new(Vec::new()),
            tickets: StdMutex::new(0),
            uploads: StdMutex::new(0),
        })
    }

    struct SourceSyncRemote {
        manifest: StdMutex<Vec<ArtManifestEntry>>,
        sources: Vec<CatalogueSourceEntry>,
        pending: StdMutex<BTreeMap<String, ArtManifestEntry>>,
        uploads: StdMutex<u32>,
    }

    #[async_trait]
    impl ArtRemote for SourceSyncRemote {
        async fn manifest_page(&self, _cursor: Option<&str>) -> Result<ArtManifestPage> {
            Ok(ArtManifestPage {
                entries: self.manifest.lock().expect("manifest").clone(),
                cursor: None,
            })
        }

        async fn catalogue_source_page(
            &self,
            _cursor: Option<&str>,
        ) -> Result<CatalogueSourcePage> {
            Ok(CatalogueSourcePage {
                entries: self.sources.clone(),
                cursor: None,
            })
        }

        async fn download_to(
            &self,
            _entry: &ArtManifestEntry,
            _start: u64,
            _destination: &Path,
        ) -> Result<DownloadMode> {
            Err(DesktopError::InvalidCloudResponse(
                "R2 download was not expected".to_string(),
            ))
        }

        async fn issue_upload_ticket(&self, entry: &ArtManifestEntry) -> Result<UploadTicket> {
            let token = manifest_key(&entry.card_id, entry.variant);
            self.pending
                .lock()
                .expect("pending")
                .insert(token.clone(), entry.clone());
            Ok(UploadTicket {
                token,
                upload_path: "/upload".to_string(),
            })
        }

        async fn upload(&self, ticket: &UploadTicket, _bytes: Vec<u8>) -> Result<()> {
            let entry = self
                .pending
                .lock()
                .expect("pending")
                .remove(&ticket.token)
                .expect("issued ticket");
            self.manifest.lock().expect("manifest").push(entry);
            *self.uploads.lock().expect("uploads") += 1;
            Ok(())
        }
    }

    struct MockCardSource {
        image_base_calls: AtomicUsize,
        downloads: AtomicUsize,
        fail_once: StdMutex<bool>,
        starts: StdMutex<Vec<u64>>,
    }

    #[async_trait]
    impl CardArtSource for MockCardSource {
        async fn image_base(&self, _source: &CatalogueSourceEntry) -> Result<Option<Url>> {
            self.image_base_calls.fetch_add(1, Ordering::SeqCst);
            Ok(Some(
                Url::parse("https://assets.tcgdex.net/en/base/base1/4").expect("image URL"),
            ))
        }

        async fn download_to(
            &self,
            _image_base: &Url,
            variant: ArtVariant,
            start: u64,
            destination: &Path,
        ) -> Result<DownloadMode> {
            self.downloads.fetch_add(1, Ordering::SeqCst);
            self.starts.lock().expect("source starts").push(start);
            let payload = match variant {
                ArtVariant::High => b"RIFF\x08\x00\x00\x00WEBPhigh".as_slice(),
                ArtVariant::Low => b"RIFF\x07\x00\x00\x00WEBPlow".as_slice(),
            };
            let mut options = std::fs::OpenOptions::new();
            options.create(true).write(true);
            if start > 0 {
                options.append(true);
            } else {
                options.truncate(true);
            }
            use std::io::Write;
            let mut file = options.open(destination)?;
            if *self.fail_once.lock().expect("source failure") {
                *self.fail_once.lock().expect("source failure") = false;
                file.write_all(&payload[..payload.len() / 2])?;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionReset,
                    "source interrupted",
                )
                .into());
            }
            file.write_all(&payload[start as usize..])?;
            Ok(if start > 0 {
                DownloadMode::Resumed
            } else {
                DownloadMode::Restarted
            })
        }
    }

    fn source_entry(card_id: &str, source_id: &str) -> CatalogueSourceEntry {
        CatalogueSourceEntry {
            card_id: card_id.to_string(),
            provider: "tcgdex".to_string(),
            source_id: source_id.to_string(),
            language: "en".to_string(),
            source_updated_at: 1_787_568_000,
            source_checksum: "a".repeat(64),
        }
    }

    #[tokio::test]
    async fn interrupted_download_resumes_from_the_partial_file() {
        let root = tempdir().expect("temp dir");
        let remote = remote(webp(), None, true);
        let engine = ArtSyncEngine::new(root.path().join("art"), remote.clone());

        engine
            .synchronize()
            .await
            .expect_err("first run interrupted");
        let report = engine.synchronize().await.expect("resumed sync");

        assert_eq!(report.downloaded, 1);
        assert_eq!(report.resumed, 1);
        let starts = remote.starts.lock().expect("starts").clone();
        assert_eq!(starts[0], 0);
        assert!(starts[1] > 0);
    }

    #[tokio::test]
    async fn checksum_mismatch_removes_the_untrusted_partial_file() {
        let root = tempdir().expect("temp dir");
        let remote = remote(webp(), Some("0".repeat(64)), false);
        let engine = ArtSyncEngine::new(root.path().join("art"), remote.clone());
        let error = engine.synchronize().await.expect_err("hash mismatch");

        assert!(matches!(error, DesktopError::ChecksumMismatch { .. }));
        let destination = local_art_path(&root.path().join("art"), &remote.entry);
        assert!(!destination.with_extension("webp.part").exists());
    }

    #[tokio::test]
    async fn matching_remote_hash_skips_duplicate_upload() {
        let root = tempdir().expect("temp dir");
        let payload = webp();
        let remote = remote(payload.clone(), None, false);
        let local = root.path().join("card.webp");
        tokio::fs::write(&local, &payload).await.expect("local art");
        let engine = ArtSyncEngine::new(root.path().join("art"), remote.clone());

        let outcome = engine
            .upload_local(&remote.entry.card_id, remote.entry.variant, &local)
            .await
            .expect("upload comparison");

        assert_eq!(outcome, UploadOutcome::AlreadyPresent);
        assert_eq!(*remote.tickets.lock().expect("tickets"), 0);
        assert_eq!(*remote.uploads.lock().expect("uploads"), 0);
    }

    #[tokio::test]
    async fn repository_library_syncs_through_filesystem_only() {
        let root = tempdir().expect("temp dir");
        std::fs::create_dir(root.path().join(".git")).expect("git marker");
        let remote = remote(webp(), None, false);
        let engine = ArtSyncEngine::new(root.path().join("images"), remote.clone());

        let report = engine.synchronize().await.expect("repository path sync");

        assert_eq!(report.downloaded, 1);
        assert_eq!(remote.starts.lock().expect("starts").as_slice(), &[0]);
        assert_eq!(*remote.tickets.lock().expect("tickets"), 0);
        assert_eq!(*remote.uploads.lock().expect("uploads"), 0);
    }

    #[tokio::test]
    async fn empty_r2_is_populated_then_the_incremental_sync_is_a_no_op() {
        let root = tempdir().expect("temp dir");
        let remote = Arc::new(SourceSyncRemote {
            manifest: StdMutex::new(Vec::new()),
            sources: vec![source_entry("card-1", "base1-4")],
            pending: StdMutex::new(BTreeMap::new()),
            uploads: StdMutex::new(0),
        });
        let source = Arc::new(MockCardSource {
            image_base_calls: AtomicUsize::new(0),
            downloads: AtomicUsize::new(0),
            fail_once: StdMutex::new(false),
            starts: StdMutex::new(Vec::new()),
        });
        let engine =
            ArtSyncEngine::with_source(root.path().join("art"), remote.clone(), source.clone());

        let first = engine.synchronize().await.expect("first source sync");
        let second = engine.synchronize().await.expect("incremental source sync");

        assert_eq!(first.source_cards, 1);
        assert_eq!(first.downloaded, 2);
        assert_eq!(first.uploaded, 2);
        assert_eq!(second.uploaded, 0);
        assert_eq!(second.downloaded, 0);
        assert_eq!(second.skipped, 2);
        assert_eq!(source.image_base_calls.load(Ordering::SeqCst), 1);
        assert_eq!(source.downloads.load(Ordering::SeqCst), 2);
        assert_eq!(*remote.uploads.lock().expect("uploads"), 2);
    }

    #[tokio::test]
    async fn interrupted_tcgdex_download_resumes_before_upload() {
        let root = tempdir().expect("temp dir");
        let remote = Arc::new(SourceSyncRemote {
            manifest: StdMutex::new(Vec::new()),
            sources: vec![source_entry("card-1", "base1-4")],
            pending: StdMutex::new(BTreeMap::new()),
            uploads: StdMutex::new(0),
        });
        let source = Arc::new(MockCardSource {
            image_base_calls: AtomicUsize::new(0),
            downloads: AtomicUsize::new(0),
            fail_once: StdMutex::new(true),
            starts: StdMutex::new(Vec::new()),
        });
        let engine =
            ArtSyncEngine::with_source(root.path().join("art"), remote.clone(), source.clone());

        engine
            .synchronize()
            .await
            .expect_err("interrupted source download");
        let report = engine.synchronize().await.expect("resumed source sync");

        assert_eq!(report.resumed, 1);
        let starts = source.starts.lock().expect("source starts");
        assert_eq!(starts[0], 0);
        assert!(starts[1] > 0);
        assert_eq!(*remote.uploads.lock().expect("uploads"), 2);
    }

    #[derive(Clone)]
    struct ListRequestState {
        requests: Arc<AtomicUsize>,
    }

    async fn tcgdex_card_list(State(state): State<ListRequestState>) -> Json<serde_json::Value> {
        state.requests.fetch_add(1, Ordering::SeqCst);
        Json(serde_json::json!([
            {
                "id": "base1-4",
                "image": "https://assets.tcgdex.net/en/base/base1/4"
            },
            {
                "id": "base1-5",
                "image": "https://assets.tcgdex.net/en/base/base1/5"
            }
        ]))
    }

    #[tokio::test]
    async fn tcgdex_card_list_is_fetched_once_for_multiple_cards_in_one_language() {
        let requests = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let router = Router::new()
            .route("/en/cards", get(tcgdex_card_list))
            .with_state(ListRequestState {
                requests: requests.clone(),
            });
        tokio::spawn(async move {
            axum::serve(listener, router).await.expect("TCGdex mock");
        });
        let source = TcgdexArtSource {
            http: reqwest::Client::new(),
            api_base: Url::parse(&format!("http://{address}/")).expect("API base"),
            language_cards: RwLock::new(HashMap::new()),
            detail_fallbacks: Mutex::new(HashMap::new()),
        };

        let first = source
            .image_base(&source_entry("card-1", "base1-4"))
            .await
            .expect("first image");
        let second = source
            .image_base(&source_entry("card-2", "base1-5"))
            .await
            .expect("second image");
        for _ in 0..100 {
            source
                .image_base(&source_entry("card-1", "base1-4"))
                .await
                .expect("cached image");
        }

        assert!(first.is_some());
        assert!(second.is_some());
        assert_eq!(requests.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn card_identifier_is_encoded_as_one_path_component() {
        let entry = ArtManifestEntry {
            card_id: "../../escape".to_string(),
            variant: ArtVariant::Low,
            sha256: "a".repeat(64),
            bytes: 1,
        };
        let path = local_art_path(Path::new("/safe"), &entry);
        assert!(path.starts_with("/safe/cards"));
        assert!(!path.to_string_lossy().contains("../"));
    }

    #[test]
    fn source_index_checkpoint_is_bounded_for_the_full_corpus() {
        assert!((100..=500).contains(&INDEX_CHECKPOINT_CARDS));
    }
}
