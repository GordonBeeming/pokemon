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
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex as AsyncMutex, OnceCell, OwnedMutexGuard, RwLock};
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
const MAX_ART_BYTES: u64 = 15 * 1024 * 1024;
const TCGDEX_RETRY_ATTEMPTS: u32 = 4;
const TCGDEX_RETRY_AFTER_CAP: Duration = Duration::from_secs(10);
static SYNC_LOCKS: LazyLock<StdMutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

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

fn sync_lock(root: &Path) -> Arc<AsyncMutex<()>> {
    let mut locks = SYNC_LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(root).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(AsyncMutex::new(()));
    locks.insert(root.to_path_buf(), Arc::downgrade(&lock));
    lock
}

async fn acquire_sync_lock(
    root: &Path,
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<OwnedMutexGuard<()>> {
    let lock = sync_lock(root);
    let Some(cancellation) = cancellation else {
        return Ok(lock.lock_owned().await);
    };
    tokio::select! {
        biased;
        () = wait_for_cancellation(cancellation) => Err(DesktopError::Cancelled),
        guard = lock.lock_owned() => Ok(guard),
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
        let _sync_guard = acquire_sync_lock(&self.root, self.cancellation.as_ref()).await?;
        self.check_cancelled()?;
        tokio::fs::create_dir_all(&self.root).await?;
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
        let mut report = SyncReport::default();
        let mut manifest_cursor: Option<String> = None;
        loop {
            self.check_cancelled()?;
            let page = cancellable(
                self.cancellation.as_ref(),
                self.remote.manifest_page(manifest_cursor.as_deref()),
            )
            .await?;
            report.manifest_entries += page.entries.len() as u64;
            index.put_remote_entries(&page.entries)?;
            match page.cursor {
                Some(next) if manifest_cursor.as_deref() != Some(next.as_str()) => {
                    manifest_cursor = Some(next)
                }
                Some(_) => {
                    return Err(DesktopError::InvalidCloudResponse(
                        "art manifest cursor did not advance".to_string(),
                    ))
                }
                None => break,
            }
        }
        let mut cards_since_checkpoint = 0_usize;
        let mut source_cursor: Option<String> = None;
        loop {
            self.check_cancelled()?;
            let page = cancellable(
                self.cancellation.as_ref(),
                self.remote.catalogue_source_page(source_cursor.as_deref()),
            )
            .await?;
            report.source_cards += page.entries.len() as u64;
            let mut work = Vec::with_capacity(page.entries.len());
            for source_entry in page.entries {
                validate_source_entry(&source_entry)?;
                let indexed = index.get(&source_entry.card_id)?;
                let remote_entries = [ArtVariant::High, ArtVariant::Low]
                    .into_iter()
                    .map(|variant| index.remote_entry(&source_entry.card_id, variant))
                    .collect::<Result<Vec<_>>>()?
                    .into_iter()
                    .flatten()
                    .collect();
                work.push(SourceCardWork {
                    source_entry,
                    indexed,
                    remote_entries,
                });
            }
            let outcomes = futures_util::stream::iter(work)
                .map(|work| self.synchronize_source_card(source, work))
                .buffered(SOURCE_CARD_CONCURRENCY)
                .collect::<Vec<_>>()
                .await;
            for outcome in outcomes {
                let outcome = outcome?;
                report.downloaded += outcome.report.downloaded;
                report.resumed += outcome.report.resumed;
                report.skipped += outcome.report.skipped;
                report.bytes_written += outcome.report.bytes_written;
                report.uploaded += outcome.report.uploaded;
                report.missing_images += outcome.report.missing_images;
                if !outcome.remote_updates.is_empty() {
                    index.put_remote_entries(&outcome.remote_updates)?;
                }
                if let Some((card_id, card)) = outcome.indexed_card {
                    index.insert(card_id, card)?;
                }
                cards_since_checkpoint += 1;
                if cards_since_checkpoint >= INDEX_CHECKPOINT_CARDS {
                    index.checkpoint()?;
                    cards_since_checkpoint = 0;
                }
            }
            match page.cursor {
                Some(next) if source_cursor.as_deref() != Some(next.as_str()) => {
                    source_cursor = Some(next)
                }
                Some(_) => {
                    return Err(DesktopError::InvalidCloudResponse(
                        "catalogue source cursor did not advance".to_string(),
                    ))
                }
                None => break,
            }
        }
        index.checkpoint()?;
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
        let downloads = futures_util::future::try_join_all(
            [ArtVariant::High, ArtVariant::Low]
                .into_iter()
                .map(|variant| {
                    self.download_source_variant(source, &source_entry, &image_base, variant)
                }),
        )
        .await?;
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
                if tokio::fs::metadata(&part)
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

struct SourceIndex {
    connection: rusqlite::Connection,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LegacySourceIndex {
    cards: BTreeMap<String, IndexedCard>,
}

impl SourceIndex {
    fn open(path: &Path) -> Result<Self> {
        let connection = rusqlite::Connection::open(path)?;
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
             );"#,
        )?;
        Ok(Self { connection })
    }

    fn get(&self, card_id: &str) -> Result<Option<IndexedCard>> {
        let mut statement = self.connection.prepare(
            r#"SELECT provider, source_id, language, source_updated_at, source_checksum, variants_json
             FROM source_cards WHERE card_id = ?1"#,
        )?;
        let mut rows = statement.query([card_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let variants_json: String = row.get(5)?;
        Ok(Some(IndexedCard {
            provider: row.get(0)?,
            source_id: row.get(1)?,
            language: row.get(2)?,
            source_updated_at: row.get(3)?,
            source_checksum: row.get(4)?,
            variants: serde_json::from_str(&variants_json)?,
        }))
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

    fn checkpoint(&self) -> Result<()> {
        self.connection
            .execute_batch("PRAGMA wal_checkpoint(PASSIVE);")?;
        Ok(())
    }

    fn clear_remote_manifest(&self) -> Result<()> {
        self.connection.execute("DELETE FROM remote_manifest", [])?;
        Ok(())
    }

    fn put_remote_entries(&mut self, entries: &[ArtManifestEntry]) -> Result<()> {
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

    fn remote_entry(&self, card_id: &str, variant: ArtVariant) -> Result<Option<ArtManifestEntry>> {
        let mut statement = self.connection.prepare(
            r#"SELECT sha256, bytes FROM remote_manifest WHERE card_id = ?1 AND variant = ?2"#,
        )?;
        let mut rows = statement.query(rusqlite::params![card_id, variant.as_str()])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(ArtManifestEntry {
            card_id: card_id.to_string(),
            variant,
            sha256: row.get(0)?,
            bytes: row.get(1)?,
        }))
    }
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

fn load_source_index(path: &Path, legacy_path: &Path) -> Result<SourceIndex> {
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
mod tests {
    use super::*;
    use axum::extract::Path as AxumPath;
    use axum::extract::State;
    use axum::routing::get;
    use axum::{Json, Router};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;
    use tempfile::tempdir;
    use tokio::sync::Notify;

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

        async fn upload(&self, _ticket: &UploadTicket, _path: &Path, _bytes: u64) -> Result<()> {
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

        async fn upload(&self, ticket: &UploadTicket, _path: &Path, _bytes: u64) -> Result<()> {
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
        ) -> Result<SourceDownload> {
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
            let should_fail = {
                let mut fail_once = self.fail_once.lock().expect("source failure");
                let should_fail = *fail_once;
                *fail_once = false;
                should_fail
            };
            if should_fail {
                file.write_all(&payload[..payload.len() / 2])?;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::ConnectionReset,
                    "source interrupted",
                )
                .into());
            }
            file.write_all(&payload[start as usize..])?;
            Ok(SourceDownload {
                mode: if start > 0 {
                    DownloadMode::Resumed
                } else {
                    DownloadMode::Restarted
                },
                sha256: sha256_file(destination).await?,
                bytes: std::fs::metadata(destination)?.len(),
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
    async fn completed_partial_is_promoted_without_an_invalid_range_request() {
        let root = tempdir().expect("temp dir");
        let payload = webp();
        let remote = remote(payload.clone(), None, false);
        let engine = ArtSyncEngine::new(root.path().join("art"), remote.clone());
        let destination = local_art_path(&engine.root, &remote.entry);
        tokio::fs::create_dir_all(destination.parent().expect("parent"))
            .await
            .expect("parent directory");
        tokio::fs::write(destination.with_extension("webp.part"), payload)
            .await
            .expect("complete partial");

        let report = engine.synchronize().await.expect("promoted partial");

        assert_eq!(report.resumed, 1);
        assert!(remote.starts.lock().expect("starts").is_empty());
        assert!(destination.is_file());
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

        assert!((1..=2).contains(&report.resumed));
        let starts = source.starts.lock().expect("source starts");
        assert_eq!(starts[0], 0);
        assert!(starts.iter().skip(1).any(|start| *start > 0));
        assert_eq!(*remote.uploads.lock().expect("uploads"), 2);
    }

    #[tokio::test]
    async fn completed_source_partial_is_promoted_without_an_eof_request() {
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
        let engine = ArtSyncEngine::with_source(root.path().join("art"), remote, source.clone());
        let placeholder = ArtManifestEntry {
            card_id: "card-1".to_string(),
            variant: ArtVariant::High,
            sha256: "0".repeat(64),
            bytes: 1,
        };
        let destination = local_art_path(&engine.root, &placeholder);
        tokio::fs::create_dir_all(destination.parent().expect("parent"))
            .await
            .expect("parent directory");
        let part = destination.with_extension("webp.source.part");
        tokio::fs::write(&part, b"RIFF\x08\x00\x00\x00WEBPhigh")
            .await
            .expect("completed source partial");
        tokio::fs::write(
            part.with_extension("meta.json"),
            serde_json::to_vec(&SourcePartialIdentity {
                source_checksum: "a".repeat(64),
                source_updated_at: 1_787_568_000,
            })
            .expect("identity"),
        )
        .await
        .expect("source identity");

        let report = engine.synchronize().await.expect("source sync");

        assert_eq!(report.resumed, 1);
        assert_eq!(source.downloads.load(Ordering::SeqCst), 1);
        assert!(destination.is_file());
        assert!(!part.exists());
    }

    struct OversizedCardSource;

    #[async_trait]
    impl CardArtSource for OversizedCardSource {
        async fn image_base(&self, _source: &CatalogueSourceEntry) -> Result<Option<Url>> {
            Ok(Some(
                Url::parse("https://assets.tcgdex.net/en/base/base1/4").expect("image URL"),
            ))
        }

        async fn download_to(
            &self,
            _image_base: &Url,
            _variant: ArtVariant,
            _start: u64,
            destination: &Path,
        ) -> Result<SourceDownload> {
            let file = tokio::fs::File::create(destination).await?;
            file.set_len(MAX_ART_BYTES + 1).await?;
            Err(DesktopError::InvalidImage("oversized source".to_string()))
        }
    }

    #[tokio::test]
    async fn oversized_source_failure_removes_partial_and_identity() {
        let root = tempdir().expect("temp dir");
        let remote = Arc::new(SourceSyncRemote {
            manifest: StdMutex::new(Vec::new()),
            sources: vec![source_entry("card-1", "base1-4")],
            pending: StdMutex::new(BTreeMap::new()),
            uploads: StdMutex::new(0),
        });
        let engine = ArtSyncEngine::with_source(
            root.path().join("art"),
            remote,
            Arc::new(OversizedCardSource),
        );

        engine.synchronize().await.expect_err("oversized source");

        let placeholder = ArtManifestEntry {
            card_id: "card-1".to_string(),
            variant: ArtVariant::High,
            sha256: "0".repeat(64),
            bytes: 1,
        };
        let part = local_art_path(&engine.root, &placeholder).with_extension("webp.source.part");
        assert!(!part.exists());
        assert!(!part.with_extension("meta.json").exists());
    }

    struct BlockingCardSource {
        started: Arc<Notify>,
    }

    #[async_trait]
    impl CardArtSource for BlockingCardSource {
        async fn image_base(&self, _source: &CatalogueSourceEntry) -> Result<Option<Url>> {
            self.started.notify_one();
            std::future::pending().await
        }

        async fn download_to(
            &self,
            _image_base: &Url,
            _variant: ArtVariant,
            _start: u64,
            _destination: &Path,
        ) -> Result<SourceDownload> {
            unreachable!("image lookup never completes")
        }
    }

    #[tokio::test]
    async fn cancellation_interrupts_an_active_source_operation() {
        let root = tempdir().expect("temp dir");
        let cancellation = Arc::new(AtomicBool::new(false));
        let started = Arc::new(Notify::new());
        let remote = Arc::new(SourceSyncRemote {
            manifest: StdMutex::new(Vec::new()),
            sources: vec![source_entry("card-1", "base1-4")],
            pending: StdMutex::new(BTreeMap::new()),
            uploads: StdMutex::new(0),
        });
        let engine = ArtSyncEngine::with_source(
            root.path().join("art"),
            remote,
            Arc::new(BlockingCardSource {
                started: started.clone(),
            }),
        )
        .with_cancellation(cancellation.clone());
        let sync = engine.synchronize();
        tokio::pin!(sync);
        tokio::select! {
            () = started.notified() => {}
            result = &mut sync => panic!("sync completed before cancellation: {result:?}"),
        }
        cancellation.store(true, Ordering::Relaxed);

        let error = tokio::time::timeout(Duration::from_secs(1), sync)
            .await
            .expect("prompt cancellation")
            .expect_err("cancelled sync");
        assert!(matches!(error, DesktopError::Cancelled));
    }

    struct ConcurrentLookupSource {
        active: AtomicUsize,
        maximum: AtomicUsize,
    }

    #[async_trait]
    impl CardArtSource for ConcurrentLookupSource {
        async fn image_base(&self, _source: &CatalogueSourceEntry) -> Result<Option<Url>> {
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.maximum.fetch_max(active, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(25)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(None)
        }

        async fn download_to(
            &self,
            _image_base: &Url,
            _variant: ArtVariant,
            _start: u64,
            _destination: &Path,
        ) -> Result<SourceDownload> {
            unreachable!("missing image has no download")
        }
    }

    #[tokio::test]
    async fn source_cards_use_bounded_concurrency() {
        let root = tempdir().expect("temp dir");
        let source = Arc::new(ConcurrentLookupSource {
            active: AtomicUsize::new(0),
            maximum: AtomicUsize::new(0),
        });
        let remote = Arc::new(SourceSyncRemote {
            manifest: StdMutex::new(Vec::new()),
            sources: (0..12)
                .map(|index| source_entry(&format!("card-{index}"), &format!("source-{index}")))
                .collect(),
            pending: StdMutex::new(BTreeMap::new()),
            uploads: StdMutex::new(0),
        });
        let engine = ArtSyncEngine::with_source(root.path().join("art"), remote, source.clone());

        let report = engine.synchronize().await.expect("bounded source sync");

        assert_eq!(report.missing_images, 12);
        assert_eq!(
            source.maximum.load(Ordering::SeqCst),
            SOURCE_CARD_CONCURRENCY
        );
    }

    #[tokio::test]
    async fn overlapping_syncs_for_one_root_are_serialized() {
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
        let first =
            ArtSyncEngine::with_source(root.path().join("art"), remote.clone(), source.clone());
        let second =
            ArtSyncEngine::with_source(root.path().join("art"), remote.clone(), source.clone());

        let (first_result, second_result) = tokio::join!(first.synchronize(), second.synchronize());

        first_result.expect("first sync");
        second_result.expect("second sync");
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

    async fn tcgdex_empty_card_list(
        State(state): State<ListRequestState>,
    ) -> Json<serde_json::Value> {
        state.requests.fetch_add(1, Ordering::SeqCst);
        Json(serde_json::json!([]))
    }

    async fn tcgdex_card_detail(
        State(state): State<ListRequestState>,
        AxumPath(id): AxumPath<String>,
    ) -> Json<serde_json::Value> {
        state.requests.fetch_add(1, Ordering::SeqCst);
        Json(serde_json::json!({
            "id": id,
            "image": "https://assets.tcgdex.net/en/base/base1/4"
        }))
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
        };

        let first_entry = source_entry("card-1", "base1-4");
        let second_entry = source_entry("card-2", "base1-5");
        let (first, second) = tokio::join!(
            source.image_base(&first_entry),
            source.image_base(&second_entry)
        );
        let first = first.expect("first image");
        let second = second.expect("second image");
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

    #[tokio::test]
    async fn detail_fallback_has_no_per_language_omission_cap() {
        let requests = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let router = Router::new()
            .route("/en/cards", get(tcgdex_empty_card_list))
            .route("/en/cards/{id}", get(tcgdex_card_detail))
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
        };

        for index in 0..101 {
            let image = source
                .image_base(&source_entry("card", &format!("missing-{index}")))
                .await
                .expect("detail fallback");
            assert!(image.is_some());
        }

        assert_eq!(requests.load(Ordering::SeqCst), 102);
    }

    #[test]
    fn retry_after_is_capped_and_backoff_has_bounded_jitter() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "999".parse().expect("header"));
        assert_eq!(retry_delay(0, &headers), TCGDEX_RETRY_AFTER_CAP);
        let delay = retry_delay(2, &reqwest::header::HeaderMap::new());
        assert!(delay >= Duration::from_secs(1));
        assert!(delay < Duration::from_millis(1_500));
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
