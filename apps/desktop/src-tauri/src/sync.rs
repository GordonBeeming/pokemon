use crate::cloud::{
    ArtManifestEntry, ArtManifestPage, ArtVariant, CatalogueSourceEntry, CatalogueSourcePage,
    CloudClient, DownloadMode, UploadTicket,
};
use crate::config::write_private;
use crate::error::{DesktopError, Result};
use async_trait::async_trait;
use futures_util::StreamExt;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{OnceCell, RwLock};
use url::Url;

mod index;
mod locking;
use self::index::{load_source_index, IndexedCard, IndexedVariant, SourceIndex};
use self::locking::acquire_sync_lock;
#[cfg(test)]
use self::locking::SYNC_LOCK_DATABASE;

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
    async fn issue_upload_tickets(
        &self,
        entries: &[ArtManifestEntry],
    ) -> Result<Vec<(ArtManifestEntry, UploadTicket)>> {
        let mut issued = Vec::with_capacity(entries.len());
        for entry in entries {
            issued.push((entry.clone(), self.issue_upload_ticket(entry).await?));
        }
        Ok(issued)
    }
    async fn upload(&self, ticket: &UploadTicket, path: &Path, bytes: u64) -> Result<()>;
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
    ) -> Result<SourceDownload>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceDownload {
    mode: DownloadMode,
    sha256: String,
    bytes: u64,
}

pub struct TcgdexArtSource {
    http: reqwest::Client,
    api_base: Url,
    language_cards: RwLock<HashMap<String, Arc<OnceCell<LanguageCardMap>>>>,
}

type LanguageCardMap = Arc<HashMap<String, Option<Url>>>;

const INDEX_CHECKPOINT_CARDS: usize = 250;
const SOURCE_CARD_CONCURRENCY: usize = 4;
const SOURCE_DISCOVERY_PAGE_CARDS: usize = 500;
const MAX_ART_BYTES: u64 = 15 * 1024 * 1024;
const TCGDEX_RETRY_ATTEMPTS: u32 = 4;
const TCGDEX_RETRY_AFTER_CAP: Duration = Duration::from_secs(10);
const TCGDEX_LIST_MAX_BYTES: usize = 25 * 1024 * 1024;
const TCGDEX_DETAIL_MAX_BYTES: usize = 2 * 1024 * 1024;

fn is_transient_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || status == reqwest::StatusCode::REQUEST_TIMEOUT
        || status.is_server_error()
}

fn retry_delay(attempt: u32, headers: &reqwest::header::HeaderMap) -> Duration {
    if let Some(seconds) = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        return Duration::from_secs(seconds).min(TCGDEX_RETRY_AFTER_CAP);
    }
    let base_millis = 250_u64.saturating_mul(1_u64 << attempt.min(4));
    let jitter_ceiling = (base_millis / 2).max(1);
    let jitter = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::from(duration.subsec_nanos()) % jitter_ceiling
        });
    Duration::from_millis(base_millis + jitter).min(TCGDEX_RETRY_AFTER_CAP)
}

async fn bounded_response_json<T: DeserializeOwned>(
    response: reqwest::Response,
    maximum_bytes: usize,
) -> Result<T> {
    if response
        .content_length()
        .is_some_and(|length| length > maximum_bytes as u64)
    {
        return Err(DesktopError::InvalidCloudResponse(
            "TCGdex JSON response exceeded its byte limit".to_string(),
        ));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if bytes.len().saturating_add(chunk.len()) > maximum_bytes {
            return Err(DesktopError::InvalidCloudResponse(
                "TCGdex JSON response exceeded its byte limit".to_string(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&bytes)?)
}

async fn wait_for_cancellation(cancellation: &AtomicBool) {
    while !cancellation.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn cancellable<T, F>(cancellation: Option<&Arc<AtomicBool>>, future: F) -> Result<T>
where
    F: Future<Output = Result<T>>,
{
    let Some(cancellation) = cancellation else {
        return future.await;
    };
    tokio::select! {
        biased;
        () = wait_for_cancellation(cancellation) => Err(DesktopError::Cancelled),
        result = future => result,
    }
}

impl TcgdexArtSource {
    pub fn new() -> Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("pokedex-desktop/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(60))
                .build()?,
            api_base: Url::parse("https://api.tcgdex.net/v2/")?,
            language_cards: RwLock::new(HashMap::new()),
        })
    }

    async fn send_with_retry(
        &self,
        context: &str,
        request: impl Fn() -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response> {
        for attempt in 0..TCGDEX_RETRY_ATTEMPTS {
            match request().send().await {
                Ok(response)
                    if is_transient_status(response.status())
                        && attempt + 1 < TCGDEX_RETRY_ATTEMPTS =>
                {
                    let delay = retry_delay(attempt, response.headers());
                    tracing::warn!(
                        target: "pokedex.sync",
                        provider = "tcgdex",
                        operation = context,
                        attempt = attempt + 1,
                        status = response.status().as_u16(),
                        delay_ms = delay.as_millis(),
                        "retrying transient TCGdex response"
                    );
                    drop(response);
                    tokio::time::sleep(delay).await;
                }
                Ok(response) => return Ok(response),
                Err(error) if attempt + 1 < TCGDEX_RETRY_ATTEMPTS => {
                    let delay = retry_delay(attempt, &reqwest::header::HeaderMap::new());
                    tracing::warn!(
                        target: "pokedex.sync",
                        provider = "tcgdex",
                        operation = context,
                        attempt = attempt + 1,
                        error = %error,
                        delay_ms = delay.as_millis(),
                        "retrying failed TCGdex request"
                    );
                    tokio::time::sleep(delay).await;
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(DesktopError::InvalidCloudResponse(format!(
            "TCGdex {context} exhausted retries"
        )))
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
        let existing = {
            let cards = self.language_cards.read().await;
            cards.get(language).cloned()
        };
        let cell = if let Some(cell) = existing {
            cell
        } else {
            let mut cards = self.language_cards.write().await;
            Arc::clone(
                cards
                    .entry(language.to_string())
                    .or_insert_with(|| Arc::new(OnceCell::new())),
            )
        };
        let indexed = cell
            .get_or_try_init(|| async {
                let path = format!("{}/cards", utf8_percent_encode(language, NON_ALPHANUMERIC));
                let url = self.api_base.join(&path)?;
                let response = self
                    .send_with_retry("card-list", || self.http.get(url.clone()))
                    .await?;
                if !response.status().is_success() {
                    return Err(DesktopError::InvalidCloudResponse(format!(
                        "TCGdex card list request failed with status {}",
                        response.status().as_u16()
                    )));
                }
                let cards: Vec<TcgdexCardBrief> =
                    bounded_response_json(response, TCGDEX_LIST_MAX_BYTES).await?;
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
                Ok(Arc::new(indexed))
            })
            .await?;
        Ok(Arc::clone(indexed))
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
        let path = format!(
            "{}/cards/{}",
            utf8_percent_encode(&source.language, NON_ALPHANUMERIC),
            utf8_percent_encode(&source.source_id, NON_ALPHANUMERIC)
        );
        let url = self.api_base.join(&path)?;
        let response = self
            .send_with_retry("card-detail", || self.http.get(url.clone()))
            .await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(DesktopError::InvalidCloudResponse(format!(
                "TCGdex card request failed with status {}",
                response.status().as_u16()
            )));
        }
        let card: TcgdexCard = bounded_response_json(response, TCGDEX_DETAIL_MAX_BYTES).await?;
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
    ) -> Result<SourceDownload> {
        let url = Self::image_url(image_base, variant)?;
        let response = self
            .send_with_retry("art-download", || {
                let request = self.http.get(url.clone());
                if start > 0 {
                    request.header(reqwest::header::RANGE, format!("bytes={start}-"))
                } else {
                    request
                }
            })
            .await?;
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
        let mut hasher = Sha256::new();
        if resumed {
            hash_file_into(destination, &mut hasher).await?;
        }
        let mut stream = response.bytes_stream();
        let mut written = if resumed { start } else { 0 };
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            written = written.saturating_add(chunk.len() as u64);
            if written > MAX_ART_BYTES {
                drop(file);
                let _ = tokio::fs::remove_file(destination).await;
                return Err(DesktopError::InvalidImage(
                    "TCGdex art exceeded 15 MiB while streaming".to_string(),
                ));
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        file.sync_all().await?;
        Ok(SourceDownload {
            mode: if resumed {
                DownloadMode::Resumed
            } else {
                DownloadMode::Restarted
            },
            sha256: hex::encode(hasher.finalize()),
            bytes: written,
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

    async fn issue_upload_tickets(
        &self,
        entries: &[ArtManifestEntry],
    ) -> Result<Vec<(ArtManifestEntry, UploadTicket)>> {
        self.client
            .issue_upload_tickets(&self.base_url, &self.token, entries)
            .await
    }

    async fn upload(&self, ticket: &UploadTicket, path: &Path, bytes: u64) -> Result<()> {
        self.client
            .upload_art_file(&self.base_url, ticket, path, bytes)
            .await
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
    cancellation: Option<Arc<AtomicBool>>,
}

impl ArtSyncEngine {
    pub fn new(root: PathBuf, remote: Arc<dyn ArtRemote>) -> Self {
        Self {
            root,
            remote,
            source: None,
            cancellation: None,
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
            cancellation: None,
        }
    }

    pub fn with_cancellation(mut self, cancellation: Arc<AtomicBool>) -> Self {
        self.cancellation = Some(cancellation);
        self
    }

    fn check_cancelled(&self) -> Result<()> {
        if self
            .cancellation
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
        {
            return Err(DesktopError::Cancelled);
        }
        Ok(())
    }

    pub async fn synchronize(&self) -> Result<SyncReport> {
        validate_library_path(&self.root)?;
        tokio::fs::create_dir_all(&self.root).await?;
        let _sync_guard = acquire_sync_lock(&self.root, self.cancellation.as_ref()).await?;
        self.check_cancelled()?;
        self.write_status("running", None, None)?;
        let result = if let Some(source) = self.source.as_ref() {
            self.synchronize_sources(source).await
        } else {
            self.synchronize_remote_manifest().await
        };
        match &result {
            Ok(report) => self.write_status("complete", Some(report), None)?,
            Err(error) => self.write_status("failed", None, Some(&error.to_string()))?,
        }
        result
    }

    fn write_status(
        &self,
        state: &str,
        report: Option<&SyncReport>,
        error: Option<&str>,
    ) -> Result<()> {
        write_private(
            &self.root.join("sync-status.json"),
            &serde_json::to_vec_pretty(&serde_json::json!({
                "state": state,
                "updatedAt": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|reason| DesktopError::InvalidImage(reason.to_string()))?
                    .as_secs(),
                "report": report,
                "error": error,
            }))?,
        )
    }

    async fn synchronize_remote_manifest(&self) -> Result<SyncReport> {
        let mut report = SyncReport::default();
        let mut cursor: Option<String> = None;
        loop {
            self.check_cancelled()?;
            let page = cancellable(
                self.cancellation.as_ref(),
                self.remote.manifest_page(cursor.as_deref()),
            )
            .await?;
            report.manifest_entries += page.entries.len() as u64;
            let outcomes = futures_util::stream::iter(page.entries)
                .map(|entry| async move { self.synchronize_entry(&entry).await })
                .buffered(SOURCE_CARD_CONCURRENCY)
                .collect::<Vec<_>>()
                .await;
            for outcome in outcomes {
                let outcome = outcome?;
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
        Ok(report)
    }

    async fn synchronize_sources(&self, source: &Arc<dyn CardArtSource>) -> Result<SyncReport> {
        let index_path = self.root.join("source-index.sqlite3");
        let legacy_index_path = self.root.join("source-index.json");
        let mut index = load_source_index(&index_path, &legacy_index_path)?;
        index.clear_remote_manifest()?;
        index.clear_source_queue()?;
        let mut report = SyncReport::default();
        let (manifest_entries, source_cards) = tokio::try_join!(
            self.discover_remote_manifest(&mut index),
            self.discover_source_queue(&index_path),
        )?;
        report.manifest_entries = manifest_entries;
        report.source_cards = source_cards;
        let mut after_sequence = None;
        let mut cards_since_checkpoint = 0_usize;
        loop {
            self.check_cancelled()?;
            let queued = index.source_queue_page(after_sequence, SOURCE_DISCOVERY_PAGE_CARDS)?;
            if queued.is_empty() {
                break;
            }
            after_sequence = queued.last().map(|(sequence, _entry)| *sequence);
            let entries = queued.into_iter().map(|(_sequence, entry)| entry).collect();
            let page_report = self
                .synchronize_source_page(source, &mut index, entries)
                .await?;
            report.downloaded += page_report.downloaded;
            report.resumed += page_report.resumed;
            report.skipped += page_report.skipped;
            report.bytes_written += page_report.bytes_written;
            report.uploaded += page_report.uploaded;
            report.missing_images += page_report.missing_images;
            cards_since_checkpoint += page_report.source_cards as usize;
            if cards_since_checkpoint >= INDEX_CHECKPOINT_CARDS {
                index.checkpoint()?;
                cards_since_checkpoint = 0;
            }
        }
        index.checkpoint()?;
        Ok(report)
    }

    async fn discover_remote_manifest(&self, index: &mut SourceIndex) -> Result<u64> {
        let mut cursor: Option<String> = None;
        let mut total = 0_u64;
        loop {
            self.check_cancelled()?;
            let page = cancellable(
                self.cancellation.as_ref(),
                self.remote.manifest_page(cursor.as_deref()),
            )
            .await?;
            total += page.entries.len() as u64;
            index.put_remote_entries(&page.entries)?;
            match page.cursor {
                Some(next) if cursor.as_deref() != Some(next.as_str()) => cursor = Some(next),
                Some(_) => {
                    return Err(DesktopError::InvalidCloudResponse(
                        "art manifest cursor did not advance".to_string(),
                    ))
                }
                None => return Ok(total),
            }
        }
    }

    async fn discover_source_queue(&self, index_path: &Path) -> Result<u64> {
        let mut index = SourceIndex::open(index_path)?;
        let mut cursor: Option<String> = None;
        let mut next_sequence = 1_u64;
        let mut total = 0_u64;
        loop {
            self.check_cancelled()?;
            let page = cancellable(
                self.cancellation.as_ref(),
                self.remote.catalogue_source_page(cursor.as_deref()),
            )
            .await?;
            for entry in &page.entries {
                validate_source_entry(entry)?;
            }
            next_sequence = index.stage_source_page(next_sequence, &page.entries)?;
            total += page.entries.len() as u64;
            match page.cursor {
                Some(next) if cursor.as_deref() != Some(next.as_str()) => cursor = Some(next),
                Some(_) => {
                    return Err(DesktopError::InvalidCloudResponse(
                        "catalogue source cursor did not advance".to_string(),
                    ))
                }
                None => return Ok(total),
            }
        }
    }

    async fn synchronize_source_page(
        &self,
        source: &Arc<dyn CardArtSource>,
        index: &mut SourceIndex,
        entries: Vec<CatalogueSourceEntry>,
    ) -> Result<SyncReport> {
        for source_entry in &entries {
            validate_source_entry(source_entry)?;
        }
        let source_cards = entries.len() as u64;
        let work = index.load_page_work(entries)?;
        let mut groups: Vec<Vec<SourceCardWork>> = Vec::new();
        let mut group_by_card = HashMap::<String, usize>::new();
        for item in work {
            let card_id = item.source_entry.card_id.clone();
            let group_index = match group_by_card.get(&card_id) {
                Some(index) => *index,
                None => {
                    let index = groups.len();
                    groups.push(Vec::new());
                    group_by_card.insert(card_id, index);
                    index
                }
            };
            groups[group_index].push(item);
        }
        let grouped_outcomes = futures_util::stream::iter(groups)
            .map(|group| async move {
                let mut outcomes = Vec::with_capacity(group.len());
                for work in group {
                    outcomes.push(self.synchronize_source_card(source, work).await?);
                }
                Ok::<_, DesktopError>(outcomes)
            })
            .buffered(SOURCE_CARD_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;
        let mut outcomes = Vec::new();
        for group in grouped_outcomes {
            outcomes.extend(group?);
        }
        index.apply_source_outcomes(&outcomes)?;
        let mut report = SyncReport {
            source_cards,
            ..SyncReport::default()
        };
        for outcome in outcomes {
            report.downloaded += outcome.report.downloaded;
            report.resumed += outcome.report.resumed;
            report.skipped += outcome.report.skipped;
            report.bytes_written += outcome.report.bytes_written;
            report.uploaded += outcome.report.uploaded;
            report.missing_images += outcome.report.missing_images;
        }
        Ok(report)
    }

    async fn synchronize_source_card(
        &self,
        source: &Arc<dyn CardArtSource>,
        work: SourceCardWork,
    ) -> Result<SourceCardOutcome> {
        self.check_cancelled()?;
        let SourceCardWork {
            source_entry,
            indexed,
            remote_entries,
        } = work;
        if indexed
            .as_ref()
            .is_some_and(|card| card.matches_source(&source_entry))
        {
            let expected = [ArtVariant::High, ArtVariant::Low]
                .into_iter()
                .map(|variant| {
                    let expected = indexed
                        .as_ref()
                        .and_then(|card| card.entry(&source_entry.card_id, variant));
                    let remote = remote_entries.iter().find(|entry| entry.variant == variant);
                    expected.filter(|entry| remote == Some(entry))
                })
                .collect::<Option<Vec<_>>>();
            if let Some(expected) = expected {
                let mut outcome = SourceCardOutcome::default();
                for entry in expected {
                    match self.synchronize_entry(&entry).await? {
                        EntryOutcome::Downloaded { bytes, resumed } => {
                            outcome.report.downloaded += 1;
                            outcome.report.bytes_written += bytes;
                            if resumed {
                                outcome.report.resumed += 1;
                            }
                        }
                        EntryOutcome::Skipped => outcome.report.skipped += 1,
                    }
                }
                return Ok(outcome);
            }
        }

        let Some(image_base) =
            cancellable(self.cancellation.as_ref(), source.image_base(&source_entry)).await?
        else {
            return Ok(SourceCardOutcome {
                report: SyncReport {
                    missing_images: 1,
                    ..SyncReport::default()
                },
                ..SourceCardOutcome::default()
            });
        };
        let downloads =
            futures_util::future::join_all([ArtVariant::High, ArtVariant::Low].into_iter().map(
                |variant| self.download_source_variant(source, &source_entry, &image_base, variant),
            ))
            .await
            .into_iter()
            .collect::<Result<Vec<_>>>()?;
        let mut outcome = SourceCardOutcome::default();
        let mut indexed_variants = BTreeMap::new();
        let mut pending_uploads = Vec::new();
        for (entry, resumed) in downloads {
            outcome.report.downloaded += 1;
            outcome.report.bytes_written += entry.bytes;
            if resumed {
                outcome.report.resumed += 1;
            }
            if remote_entries.iter().any(|remote| remote == &entry) {
                outcome.report.skipped += 1;
            } else {
                pending_uploads.push(entry.clone());
            }
            indexed_variants.insert(
                entry.variant.as_str().to_string(),
                IndexedVariant::from(&entry),
            );
        }
        if !pending_uploads.is_empty() {
            let tickets = cancellable(
                self.cancellation.as_ref(),
                self.remote.issue_upload_tickets(&pending_uploads),
            )
            .await?;
            futures_util::future::try_join_all(tickets.iter().map(|(entry, ticket)| {
                let remote = Arc::clone(&self.remote);
                let cancellation = self.cancellation.clone();
                let ticket = ticket.clone();
                let path = local_art_path(&self.root, entry);
                let bytes = entry.bytes;
                async move {
                    cancellable(cancellation.as_ref(), remote.upload(&ticket, &path, bytes)).await
                }
            }))
            .await?;
            outcome.report.uploaded += tickets.len() as u64;
            outcome.remote_updates = tickets.into_iter().map(|(entry, _)| entry).collect();
        }
        outcome.indexed_card = Some((
            source_entry.card_id,
            IndexedCard {
                provider: source_entry.provider,
                source_id: source_entry.source_id,
                language: source_entry.language,
                source_updated_at: source_entry.source_updated_at,
                source_checksum: source_entry.source_checksum,
                variants: indexed_variants,
            },
        ));
        Ok(outcome)
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
        let partial_identity_path = part.with_extension("meta.json");
        let expected_identity = SourcePartialIdentity {
            source_checksum: source_entry.source_checksum.clone(),
            source_updated_at: source_entry.source_updated_at,
        };
        let mut start = tokio::fs::metadata(&part)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let identity_matches = tokio::fs::read(&partial_identity_path)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SourcePartialIdentity>(&bytes).ok())
            .as_ref()
            == Some(&expected_identity);
        if start > 0 && !identity_matches {
            remove_if_present(&part).await?;
            remove_if_present(&partial_identity_path).await?;
            start = 0;
        }
        if start > MAX_ART_BYTES {
            remove_if_present(&part).await?;
            remove_if_present(&partial_identity_path).await?;
            start = 0;
        }
        if start > 0 {
            match webp_file_state(&part, MAX_ART_BYTES).await? {
                WebpFileState::Complete { bytes, sha256 } => {
                    let entry = ArtManifestEntry {
                        card_id: source_entry.card_id.clone(),
                        variant,
                        sha256,
                        bytes,
                    };
                    tokio::fs::rename(&part, &destination).await?;
                    remove_if_present(&partial_identity_path).await?;
                    save_file_identity(&destination, &entry).await?;
                    return Ok((entry, true));
                }
                WebpFileState::Invalid => {
                    remove_if_present(&part).await?;
                    start = 0;
                }
                WebpFileState::Incomplete => {}
            }
        }
        write_private(
            &partial_identity_path,
            &serde_json::to_vec(&expected_identity)?,
        )?;
        let download = cancellable(
            self.cancellation.as_ref(),
            source.download_to(image_base, variant, start, &part),
        )
        .await;
        let download = match download {
            Ok(download) => download,
            Err(error) => {
                if matches!(&error, DesktopError::Cancelled)
                    || tokio::fs::metadata(&part)
                        .await
                        .is_ok_and(|metadata| metadata.len() > MAX_ART_BYTES)
                {
                    remove_if_present(&part).await?;
                    remove_if_present(&partial_identity_path).await?;
                } else if !part.exists() {
                    remove_if_present(&partial_identity_path).await?;
                }
                return Err(error);
            }
        };
        if !matches!(webp_file_state(&part, MAX_ART_BYTES).await?, WebpFileState::Complete { bytes, ref sha256 } if bytes == download.bytes && sha256 == &download.sha256)
        {
            remove_if_present(&part).await?;
            remove_if_present(&partial_identity_path).await?;
            return Err(DesktopError::InvalidImage(format!(
                "TCGdex {}/{} did not return a valid WebP image",
                source_entry.source_id,
                variant.as_str()
            )));
        }
        let entry = ArtManifestEntry {
            card_id: source_entry.card_id.clone(),
            variant,
            sha256: download.sha256,
            bytes: download.bytes,
        };
        tokio::fs::rename(part, &destination).await?;
        remove_if_present(&partial_identity_path).await?;
        save_file_identity(&destination, &entry).await?;
        Ok((entry, download.mode == DownloadMode::Resumed))
    }

    pub async fn upload_local(
        &self,
        card_id: &str,
        variant: ArtVariant,
        path: &Path,
    ) -> Result<UploadOutcome> {
        validate_library_path(&self.root)?;
        tokio::fs::create_dir_all(&self.root).await?;
        let _sync_guard = acquire_sync_lock(&self.root, self.cancellation.as_ref()).await?;
        let WebpFileState::Complete { bytes, sha256 } =
            webp_file_state(path, MAX_ART_BYTES).await?
        else {
            return Err(DesktopError::InvalidImage(
                "art uploads must be complete WebP files".to_string(),
            ));
        };
        let entry = ArtManifestEntry {
            card_id: card_id.to_string(),
            variant,
            sha256,
            bytes,
        };
        if self
            .full_manifest()
            .await?
            .iter()
            .any(|remote| remote == &entry)
        {
            return Ok(UploadOutcome::AlreadyPresent);
        }
        let ticket = cancellable(
            self.cancellation.as_ref(),
            self.remote.issue_upload_ticket(&entry),
        )
        .await?;
        cancellable(
            self.cancellation.as_ref(),
            self.remote.upload(&ticket, path, entry.bytes),
        )
        .await?;
        Ok(UploadOutcome::Uploaded)
    }

    async fn full_manifest(&self) -> Result<Vec<ArtManifestEntry>> {
        let mut entries = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = cancellable(
                self.cancellation.as_ref(),
                self.remote.manifest_page(cursor.as_deref()),
            )
            .await?;
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
        if start == entry.bytes && start > 0 {
            if sha256_file(&part).await? == entry.sha256 {
                tokio::fs::rename(&part, &destination).await?;
                save_file_identity(&destination, entry).await?;
                return Ok(EntryOutcome::Downloaded {
                    bytes: entry.bytes,
                    resumed: true,
                });
            }
            tokio::fs::remove_file(&part).await?;
            start = 0;
        }
        let mode = cancellable(
            self.cancellation.as_ref(),
            self.remote.download_to(entry, start, &part),
        )
        .await?;
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
        tokio::fs::rename(&part, &destination).await?;
        save_file_identity(&destination, entry).await?;
        Ok(EntryOutcome::Downloaded {
            bytes: entry.bytes,
            resumed: mode == DownloadMode::Resumed,
        })
    }
}

struct SourceCardWork {
    source_entry: CatalogueSourceEntry,
    indexed: Option<IndexedCard>,
    remote_entries: Vec<ArtManifestEntry>,
}

#[derive(Default)]
struct SourceCardOutcome {
    report: SyncReport,
    remote_updates: Vec<ArtManifestEntry>,
    indexed_card: Option<(String, IndexedCard)>,
}

enum EntryOutcome {
    Downloaded { bytes: u64, resumed: bool },
    Skipped,
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

#[cfg(test)]
fn manifest_key(card_id: &str, variant: ArtVariant) -> String {
    format!("{card_id}|{}", variant.as_str())
}

fn validate_tcgdex_asset_url(url: &Url) -> Result<()> {
    if url.scheme() != "https" || url.host_str() != Some("assets.tcgdex.net") {
        return Err(DesktopError::InvalidCloudResponse(
            "TCGdex returned an untrusted image origin".to_string(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SourcePartialIdentity {
    source_checksum: String,
    source_updated_at: u64,
}

enum WebpFileState {
    Complete { bytes: u64, sha256: String },
    Incomplete,
    Invalid,
}

async fn webp_file_state(path: &Path, maximum_bytes: u64) -> Result<WebpFileState> {
    let bytes = tokio::fs::metadata(path).await?.len();
    if bytes > maximum_bytes {
        return Ok(WebpFileState::Invalid);
    }
    let mut file = tokio::fs::File::open(path).await?;
    let mut header = [0_u8; 12];
    match file.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            return Ok(WebpFileState::Incomplete)
        }
        Err(error) => return Err(error.into()),
    }
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WEBP" {
        return Ok(WebpFileState::Invalid);
    }
    let declared_bytes =
        u64::from(u32::from_le_bytes(header[4..8].try_into().map_err(
            |_| DesktopError::InvalidImage("invalid WebP RIFF header".to_string()),
        )?))
        .saturating_add(8);
    if declared_bytes > maximum_bytes || bytes > declared_bytes {
        return Ok(WebpFileState::Invalid);
    }
    if bytes < declared_bytes {
        return Ok(WebpFileState::Incomplete);
    }
    let mut hasher = Sha256::new();
    hash_file_into(path, &mut hasher).await?;
    Ok(WebpFileState::Complete {
        bytes,
        sha256: hex::encode(hasher.finalize()),
    })
}

async fn remove_if_present(path: &Path) -> Result<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
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
    let modified_nanos = modified_nanos(&metadata)?;
    let identity_path = identity_path(path);
    if let Ok(bytes) = tokio::fs::read(&identity_path).await {
        if let Ok(identity) = serde_json::from_slice::<FileIdentity>(&bytes) {
            if identity.sha256 == entry.sha256
                && identity.bytes == entry.bytes
                && identity.modified_nanos == modified_nanos
            {
                return Ok(true);
            }
        }
    }
    if sha256_file(path).await? != entry.sha256 {
        return Ok(false);
    }
    save_file_identity(path, entry).await?;
    Ok(true)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileIdentity {
    sha256: String,
    bytes: u64,
    modified_nanos: u128,
}

fn identity_path(path: &Path) -> PathBuf {
    path.with_extension("webp.meta.json")
}

fn modified_nanos(metadata: &std::fs::Metadata) -> Result<u128> {
    Ok(metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| DesktopError::InvalidImage(error.to_string()))?
        .as_nanos())
}

async fn save_file_identity(path: &Path, entry: &ArtManifestEntry) -> Result<()> {
    let metadata = tokio::fs::metadata(path).await?;
    let identity = FileIdentity {
        sha256: entry.sha256.clone(),
        bytes: entry.bytes,
        modified_nanos: modified_nanos(&metadata)?,
    };
    write_private(&identity_path(path), &serde_json::to_vec(&identity)?)
}

async fn sha256_file(path: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    hash_file_into(path, &mut hasher).await?;
    Ok(hex::encode(hasher.finalize()))
}

async fn hash_file_into(path: &Path, hasher: &mut Sha256) -> Result<()> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut buffer = vec![0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(())
}

#[cfg(test)]
fn sha256_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests;
