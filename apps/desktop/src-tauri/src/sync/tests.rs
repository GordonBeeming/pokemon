use super::*;
use axum::body::Body;
use axum::extract::Path as AxumPath;
use axum::extract::State;
use axum::http::{header, Response};
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

    async fn catalogue_source_page(&self, _cursor: Option<&str>) -> Result<CatalogueSourcePage> {
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
            return Err(
                std::io::Error::new(std::io::ErrorKind::ConnectionReset, "interrupted").into(),
            );
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

    async fn catalogue_source_page(&self, _cursor: Option<&str>) -> Result<CatalogueSourcePage> {
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

struct WrongHashCardSource;

#[async_trait]
impl CardArtSource for WrongHashCardSource {
    async fn image_base(&self, _source: &CatalogueSourceEntry) -> Result<Option<Url>> {
        Ok(Some(
            Url::parse("https://assets.tcgdex.net/en/base/base1/4").expect("image URL"),
        ))
    }

    async fn download_to(
        &self,
        _image_base: &Url,
        variant: ArtVariant,
        _start: u64,
        destination: &Path,
    ) -> Result<SourceDownload> {
        let payload = match variant {
            ArtVariant::High => b"RIFF\x08\x00\x00\x00WEBPhigh".as_slice(),
            ArtVariant::Low => b"RIFF\x07\x00\x00\x00WEBPlow".as_slice(),
        };
        tokio::fs::write(destination, payload).await?;
        Ok(SourceDownload {
            mode: DownloadMode::Restarted,
            sha256: "0".repeat(64),
            bytes: payload.len() as u64,
        })
    }
}

#[tokio::test]
async fn source_hash_mismatch_removes_every_variant_partial_and_identity() {
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
        Arc::new(WrongHashCardSource),
    );

    engine
        .synchronize()
        .await
        .expect_err("source hash mismatch");

    for variant in [ArtVariant::High, ArtVariant::Low] {
        let entry = ArtManifestEntry {
            card_id: "card-1".to_string(),
            variant,
            sha256: "0".repeat(64),
            bytes: 1,
        };
        let part = local_art_path(&engine.root, &entry).with_extension("webp.source.part");
        assert!(!part.exists());
        assert!(!part.with_extension("meta.json").exists());
    }
}

struct PartialBlockingCardSource {
    started: Arc<Notify>,
    started_count: Arc<AtomicUsize>,
}

#[async_trait]
impl CardArtSource for PartialBlockingCardSource {
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
        tokio::fs::write(destination, b"RIFF").await?;
        self.started_count.fetch_add(1, Ordering::Relaxed);
        self.started.notify_one();
        std::future::pending().await
    }
}

#[tokio::test]
async fn cancellation_removes_every_variant_partial_and_identity() {
    let root = tempdir().expect("temp dir");
    let cancellation = Arc::new(AtomicBool::new(false));
    let started = Arc::new(Notify::new());
    let started_count = Arc::new(AtomicUsize::new(0));
    let remote = Arc::new(SourceSyncRemote {
        manifest: StdMutex::new(Vec::new()),
        sources: vec![source_entry("card-1", "base1-4")],
        pending: StdMutex::new(BTreeMap::new()),
        uploads: StdMutex::new(0),
    });
    let engine = ArtSyncEngine::with_source(
        root.path().join("art"),
        remote,
        Arc::new(PartialBlockingCardSource {
            started: started.clone(),
            started_count: started_count.clone(),
        }),
    )
    .with_cancellation(cancellation.clone());
    let sync = engine.synchronize();
    tokio::pin!(sync);
    while started_count.load(Ordering::Relaxed) < 2 {
        tokio::select! {
            () = started.notified() => {}
            result = &mut sync => panic!("sync completed before cancellation: {result:?}"),
        }
    }
    cancellation.store(true, Ordering::Relaxed);
    let error = tokio::time::timeout(Duration::from_secs(1), sync)
        .await
        .expect("prompt cancellation")
        .expect_err("cancelled source downloads");
    assert!(matches!(error, DesktopError::Cancelled));

    for variant in [ArtVariant::High, ArtVariant::Low] {
        let entry = ArtManifestEntry {
            card_id: "card-1".to_string(),
            variant,
            sha256: "0".repeat(64),
            bytes: 1,
        };
        let part = local_art_path(&engine.root, &entry).with_extension("webp.source.part");
        assert!(!part.exists());
        assert!(!part.with_extension("meta.json").exists());
    }
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
async fn duplicate_source_rows_for_one_card_are_serialized() {
    let root = tempdir().expect("temp dir");
    let source = Arc::new(ConcurrentLookupSource {
        active: AtomicUsize::new(0),
        maximum: AtomicUsize::new(0),
    });
    let remote = Arc::new(SourceSyncRemote {
        manifest: StdMutex::new(Vec::new()),
        sources: vec![
            source_entry("card-1", "source-a"),
            source_entry("card-1", "source-b"),
        ],
        pending: StdMutex::new(BTreeMap::new()),
        uploads: StdMutex::new(0),
    });
    let engine = ArtSyncEngine::with_source(root.path().join("art"), remote, source.clone());

    let report = engine.synchronize().await.expect("same-card source sync");

    assert_eq!(report.missing_images, 2);
    assert_eq!(source.maximum.load(Ordering::SeqCst), 1);
}

struct PipelinedRemote {
    next_page_requested: Arc<Notify>,
    source_discovery_started: Arc<Notify>,
}

#[async_trait]
impl ArtRemote for PipelinedRemote {
    async fn manifest_page(&self, _cursor: Option<&str>) -> Result<ArtManifestPage> {
        self.source_discovery_started.notified().await;
        Ok(ArtManifestPage {
            entries: Vec::new(),
            cursor: None,
        })
    }

    async fn catalogue_source_page(&self, cursor: Option<&str>) -> Result<CatalogueSourcePage> {
        match cursor {
            None => {
                self.source_discovery_started.notify_one();
                Ok(CatalogueSourcePage {
                    entries: vec![source_entry("card-1", "source-a")],
                    cursor: Some("next".to_string()),
                })
            }
            Some("next") => {
                self.next_page_requested.notify_one();
                Ok(CatalogueSourcePage {
                    entries: vec![source_entry("card-2", "source-b")],
                    cursor: None,
                })
            }
            Some(_) => Err(DesktopError::InvalidCloudResponse(
                "unexpected source cursor".to_string(),
            )),
        }
    }

    async fn download_to(
        &self,
        _entry: &ArtManifestEntry,
        _start: u64,
        _destination: &Path,
    ) -> Result<DownloadMode> {
        unreachable!("missing source art is never downloaded")
    }

    async fn issue_upload_ticket(&self, _entry: &ArtManifestEntry) -> Result<UploadTicket> {
        unreachable!("missing source art is never uploaded")
    }

    async fn upload(&self, _ticket: &UploadTicket, _path: &Path, _bytes: u64) -> Result<()> {
        unreachable!("missing source art is never uploaded")
    }
}

struct PipelinedCardSource {
    next_page_requested: Arc<Notify>,
}

#[async_trait]
impl CardArtSource for PipelinedCardSource {
    async fn image_base(&self, source: &CatalogueSourceEntry) -> Result<Option<Url>> {
        if source.card_id == "card-1" {
            self.next_page_requested.notified().await;
        }
        Ok(None)
    }

    async fn download_to(
        &self,
        _image_base: &Url,
        _variant: ArtVariant,
        _start: u64,
        _destination: &Path,
    ) -> Result<SourceDownload> {
        unreachable!("missing source art is never downloaded")
    }
}

#[tokio::test]
async fn next_source_page_is_fetched_while_the_current_page_is_processed() {
    let root = tempdir().expect("temp dir");
    let next_page_requested = Arc::new(Notify::new());
    let source_discovery_started = Arc::new(Notify::new());
    let engine = ArtSyncEngine::with_source(
        root.path().join("art"),
        Arc::new(PipelinedRemote {
            next_page_requested: next_page_requested.clone(),
            source_discovery_started,
        }),
        Arc::new(PipelinedCardSource {
            next_page_requested,
        }),
    );

    let report = tokio::time::timeout(Duration::from_secs(1), engine.synchronize())
        .await
        .expect("source page pipeline did not deadlock")
        .expect("source page pipeline");

    assert_eq!(report.source_cards, 2);
    assert_eq!(report.missing_images, 2);
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
    let first = ArtSyncEngine::with_source(root.path().join("art"), remote.clone(), source.clone());
    let second =
        ArtSyncEngine::with_source(root.path().join("art"), remote.clone(), source.clone());

    let (first_result, second_result) = tokio::join!(first.synchronize(), second.synchronize());

    first_result.expect("first sync");
    second_result.expect("second sync");
    assert_eq!(*remote.uploads.lock().expect("uploads"), 2);
}

#[test]
fn cross_process_lock_holder() {
    let Ok(root) = std::env::var("POKEDEX_TEST_SYNC_LOCK_ROOT") else {
        return;
    };
    let ready = PathBuf::from(std::env::var("POKEDEX_TEST_SYNC_LOCK_READY").expect("ready path"));
    let release =
        PathBuf::from(std::env::var("POKEDEX_TEST_SYNC_LOCK_RELEASE").expect("release path"));
    std::fs::create_dir_all(&root).expect("lock root");
    let connection =
        rusqlite::Connection::open(Path::new(&root).join(SYNC_LOCK_DATABASE)).expect("lock DB");
    connection
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("exclusive lock");
    std::fs::write(&ready, b"ready").expect("ready marker");
    while !release.exists() {
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[tokio::test]
async fn filesystem_lock_rejects_a_second_process_for_the_same_root() {
    let temp = tempdir().expect("temp dir");
    let root = temp.path().join("art");
    let ready = temp.path().join("ready");
    let release = temp.path().join("release");
    let mut child = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .arg("--exact")
        .arg("sync::tests::cross_process_lock_holder")
        .arg("--nocapture")
        .env("POKEDEX_TEST_SYNC_LOCK_ROOT", &root)
        .env("POKEDEX_TEST_SYNC_LOCK_READY", &ready)
        .env("POKEDEX_TEST_SYNC_LOCK_RELEASE", &release)
        .spawn()
        .expect("lock-holder process");
    tokio::time::timeout(Duration::from_secs(5), async {
        while !ready.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("lock holder became ready");

    let engine = ArtSyncEngine::new(root.clone(), remote(webp(), None, false));
    let error = engine
        .synchronize()
        .await
        .expect_err("second process must not enter the library");
    assert!(error
        .to_string()
        .contains("art synchronization is already running"));

    let upload = temp.path().join("manual.webp");
    tokio::fs::write(&upload, webp())
        .await
        .expect("manual upload fixture");
    let upload_engine = ArtSyncEngine::new(root, remote(webp(), None, false));
    let upload_error = upload_engine
        .upload_local("card", ArtVariant::High, &upload)
        .await
        .expect_err("manual upload must share the filesystem lease");
    assert!(upload_error
        .to_string()
        .contains("art synchronization is already running"));

    std::fs::write(&release, b"release").expect("release marker");
    let status = child.wait().expect("lock-holder exit");
    assert!(status.success());
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

async fn tcgdex_empty_card_list(State(state): State<ListRequestState>) -> Json<serde_json::Value> {
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

async fn oversized_tcgdex_json() -> Response<Body> {
    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, TCGDEX_LIST_MAX_BYTES + 1)
        .body(Body::from(vec![b' '; TCGDEX_LIST_MAX_BYTES + 1]))
        .expect("oversized response")
}

async fn oversized_tcgdex_detail() -> Response<Body> {
    Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CONTENT_LENGTH, TCGDEX_DETAIL_MAX_BYTES + 1)
        .body(Body::from(vec![b' '; TCGDEX_DETAIL_MAX_BYTES + 1]))
        .expect("oversized response")
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
async fn tcgdex_list_and_detail_json_are_rejected_before_oversized_bodies_are_read() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let router = Router::new().route("/en/cards", get(oversized_tcgdex_json));
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("TCGdex mock");
    });
    let source = TcgdexArtSource {
        http: reqwest::Client::new(),
        api_base: Url::parse(&format!("http://{address}/")).expect("API base"),
        language_cards: RwLock::new(HashMap::new()),
    };
    let list_error = source
        .image_base(&source_entry("card", "source"))
        .await
        .expect_err("oversized list");
    assert!(list_error.to_string().contains("exceeded its byte limit"));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener");
    let address = listener.local_addr().expect("address");
    let router = Router::new()
        .route("/en/cards", get(tcgdex_empty_card_list))
        .route("/en/cards/{id}", get(oversized_tcgdex_detail))
        .with_state(ListRequestState {
            requests: Arc::new(AtomicUsize::new(0)),
        });
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("TCGdex mock");
    });
    let source = TcgdexArtSource {
        http: reqwest::Client::new(),
        api_base: Url::parse(&format!("http://{address}/")).expect("API base"),
        language_cards: RwLock::new(HashMap::new()),
    };
    let detail_error = source
        .image_base(&source_entry("card", "source"))
        .await
        .expect_err("oversized detail");
    assert!(detail_error.to_string().contains("exceeded its byte limit"));
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

#[test]
fn source_index_loads_and_commits_a_whole_page() {
    let root = tempdir().expect("temp dir");
    let mut index = SourceIndex::open(&root.path().join("index.sqlite3")).expect("source index");
    let remote_entry = ArtManifestEntry {
        card_id: "card-1".to_string(),
        variant: ArtVariant::High,
        sha256: "a".repeat(64),
        bytes: 20,
    };
    index
        .put_remote_entries(std::slice::from_ref(&remote_entry))
        .expect("remote page");
    let indexed = IndexedCard {
        provider: "tcgdex".to_string(),
        source_id: "source-a".to_string(),
        language: "en".to_string(),
        source_updated_at: 1,
        source_checksum: "b".repeat(64),
        variants: BTreeMap::from([("high".to_string(), IndexedVariant::from(&remote_entry))]),
    };
    let indexed_alias = IndexedCard {
        provider: "tcgdex".to_string(),
        source_id: "source-alias".to_string(),
        language: "en".to_string(),
        source_updated_at: 1,
        source_checksum: "c".repeat(64),
        variants: BTreeMap::from([("high".to_string(), IndexedVariant::from(&remote_entry))]),
    };
    index
        .apply_source_outcomes(&[
            SourceCardOutcome {
                report: SyncReport::default(),
                remote_updates: Vec::new(),
                indexed_card: Some(("card-1".to_string(), indexed)),
            },
            SourceCardOutcome {
                report: SyncReport::default(),
                remote_updates: Vec::new(),
                indexed_card: Some(("card-1".to_string(), indexed_alias)),
            },
        ])
        .expect("page transaction");

    let work = index
        .load_page_work(vec![
            source_entry("card-1", "source-a"),
            source_entry("card-1", "source-alias"),
            source_entry("card-2", "source-b"),
        ])
        .expect("page state");

    assert_eq!(work.len(), 3);
    assert!(work[0]
        .indexed
        .as_ref()
        .is_some_and(|card| card.source_id == "source-a"));
    assert!(work[1]
        .indexed
        .as_ref()
        .is_some_and(|card| card.source_id == "source-alias"));
    assert_eq!(work[0].remote_entries, [remote_entry]);
    assert_eq!(work[1].remote_entries, work[0].remote_entries);
    assert!(work[2].indexed.is_none());
    assert!(work[2].remote_entries.is_empty());
}

#[test]
fn source_index_migrates_the_card_key_to_complete_source_identity() {
    let root = tempdir().expect("temp dir");
    let path = root.path().join("index.sqlite3");
    {
        let connection = rusqlite::Connection::open(&path).expect("legacy index");
        connection
            .execute_batch(
                r#"CREATE TABLE source_cards (
                     card_id TEXT PRIMARY KEY NOT NULL,
                     provider TEXT NOT NULL,
                     source_id TEXT NOT NULL,
                     language TEXT NOT NULL,
                     source_updated_at INTEGER NOT NULL,
                     source_checksum TEXT NOT NULL,
                     variants_json TEXT NOT NULL
                   );"#,
            )
            .expect("legacy schema");
        connection
            .execute(
                "INSERT INTO source_cards VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    "card-1",
                    "tcgdex",
                    "source-a",
                    "en",
                    1,
                    "a".repeat(64),
                    "{}"
                ],
            )
            .expect("legacy row");
    }

    let index = SourceIndex::open(&path).expect("migrated source index");
    let work = index
        .load_page_work(vec![source_entry("card-1", "source-a")])
        .expect("migrated page");
    assert!(work[0]
        .indexed
        .as_ref()
        .is_some_and(|card| card.source_id == "source-a"));
}
