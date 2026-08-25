use crate::config::write_private;
use crate::error::{DesktopError, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_CAPTURE_BYTES: usize = 25 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 256 * 1024;
const DELETE_TOMBSTONE_PREFIX: &str = ".pokedex-delete-";
const DELETE_LOCK_DATABASE: &str = ".pokedex-delete-lock.sqlite3";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteEntry {
    label: String,
    original: String,
    tombstone: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum DeleteJournalState {
    Pending,
    Committed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteJournal {
    operation_id: Uuid,
    scan_id: Uuid,
    state: DeleteJournalState,
    entries: Vec<DeleteEntry>,
}

struct DeleteLock {
    connection: rusqlite::Connection,
}

impl Drop for DeleteLock {
    fn drop(&mut self) {
        let _ = self.connection.execute_batch("ROLLBACK");
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CaptureSource {
    Camera,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingScan {
    pub id: Uuid,
    pub created_at: u64,
    pub source: CaptureSource,
    pub mime_type: String,
    pub bytes: u64,
    #[serde(default = "Uuid::new_v4")]
    pub mutation_id: Uuid,
    #[serde(default)]
    pub state: ScanState,
    #[serde(default)]
    pub confirmed_card_id: Option<String>,
    #[serde(default)]
    pub completed_result: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScanState {
    #[default]
    Pending,
    Claimed,
    Completed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingScanImage {
    pub id: Uuid,
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Clone)]
pub struct PendingInbox {
    root: PathBuf,
}

impl PendingInbox {
    pub fn new(root: PathBuf) -> Self {
        let inbox = Self { root };
        match inbox.try_delete_lock() {
            Ok(Some(_lock)) => {
                if let Err(error) = inbox.recover_delete_journals() {
                    tracing::warn!(error = %error, "could not recover pending-delete journals");
                }
            }
            Ok(None) => tracing::debug!(
                "pending-delete recovery skipped because another process holds the lock"
            ),
            Err(error) => {
                tracing::warn!(error = %error, "could not acquire the pending-delete recovery lock")
            }
        }
        inbox
    }

    pub fn save(
        &self,
        bytes: &[u8],
        preview_bytes: &[u8],
        declared_mime: &str,
        source: CaptureSource,
    ) -> Result<PendingScan> {
        if bytes.is_empty() || bytes.len() > MAX_CAPTURE_BYTES {
            return Err(DesktopError::InvalidImage(format!(
                "capture must contain 1 to {MAX_CAPTURE_BYTES} bytes"
            )));
        }
        let mime_type = detect_image_mime(bytes).ok_or_else(|| {
            DesktopError::InvalidImage("expected JPEG, PNG, WebP, or HEIC data".to_string())
        })?;
        if normalize_mime(declared_mime) != mime_type {
            return Err(DesktopError::InvalidImage(format!(
                "declared MIME type {declared_mime} does not match {mime_type} data"
            )));
        }
        if preview_bytes.is_empty()
            || preview_bytes.len() > MAX_PREVIEW_BYTES
            || detect_image_mime(preview_bytes) != Some("image/jpeg")
        {
            return Err(DesktopError::InvalidImage(format!(
                "preview must contain 1 to {MAX_PREVIEW_BYTES} bytes of JPEG data"
            )));
        }
        std::fs::create_dir_all(&self.root)?;
        let id = Uuid::new_v4();
        let image_path = self.image_path(id, mime_type);
        let preview_path = self.thumbnail_path(id);
        let metadata = PendingScan {
            id,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| DesktopError::InvalidImage(error.to_string()))?
                .as_secs(),
            source,
            mime_type: mime_type.to_string(),
            bytes: bytes.len() as u64,
            mutation_id: Uuid::new_v4(),
            state: ScanState::Pending,
            confirmed_card_id: None,
            completed_result: None,
        };
        let metadata_bytes = serde_json::to_vec_pretty(&metadata)?;
        write_private(&image_path, bytes)?;
        if let Err(error) = write_private(&preview_path, preview_bytes) {
            return Err(rollback_save(
                "pending preview write",
                error,
                &[("capture", image_path.as_path())],
            ));
        }
        if let Err(error) = write_private(&self.metadata_path(id), &metadata_bytes) {
            return Err(rollback_save(
                "pending metadata write",
                error,
                &[
                    ("preview", preview_path.as_path()),
                    ("capture", image_path.as_path()),
                ],
            ));
        }
        Ok(metadata)
    }

    pub fn list(&self) -> Result<Vec<PendingScan>> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let mut scans = Vec::new();
        for entry in std::fs::read_dir(&self.root)? {
            let path = entry?.path();
            if path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.starts_with(DELETE_TOMBSTONE_PREFIX))
            {
                continue;
            }
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            match self.read_metadata_path(&path) {
                Ok(scan)
                    if self.image_path(scan.id, &scan.mime_type).is_file()
                        || scan.state == ScanState::Completed =>
                {
                    scans.push(scan);
                }
                Ok(_) => {
                    tracing::warn!(path = %path.display(), "pending scan image is missing");
                }
                Err(error) => {
                    let quarantine = path.with_extension("json.invalid");
                    if let Err(rename_error) = std::fs::rename(&path, &quarantine) {
                        tracing::warn!(
                            path = %path.display(),
                            error = %error,
                            rename_error = %rename_error,
                            "could not quarantine invalid pending scan metadata"
                        );
                    } else {
                        tracing::warn!(
                            path = %path.display(),
                            error = %error,
                            "quarantined invalid pending scan metadata"
                        );
                    }
                }
            }
        }
        scans.sort_by_key(|scan| (scan.created_at, scan.id));
        Ok(scans)
    }

    pub fn read_image(&self, id: Uuid) -> Result<PendingScanImage> {
        let scan = self.read_metadata(id)?;
        let bytes = std::fs::read(self.image_path(id, &scan.mime_type))?;
        Ok(PendingScanImage {
            id,
            mime_type: scan.mime_type,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }

    pub fn preview_path(&self, id: Uuid) -> Result<PathBuf> {
        self.read_metadata(id)?;
        let path = self.thumbnail_path(id);
        if !path.is_file() {
            return Err(DesktopError::InvalidPath(path));
        }
        Ok(path)
    }

    pub fn delete(&self, id: Uuid) -> Result<()> {
        let scan = self.read_metadata(id)?;
        self.delete_scan(&scan)
    }

    pub fn claim(&self, id: Uuid, card_id: &str) -> Result<PendingScan> {
        let mut scan = self.read_metadata(id)?;
        match scan.state {
            ScanState::Pending => {
                scan.state = ScanState::Claimed;
                scan.confirmed_card_id = Some(card_id.to_string());
                self.write_metadata(&scan)?;
            }
            ScanState::Claimed | ScanState::Completed => {
                if scan.confirmed_card_id.as_deref() != Some(card_id) {
                    return Err(DesktopError::Mcp(
                        "scan is already claimed for a different card".to_string(),
                    ));
                }
            }
        }
        Ok(scan)
    }

    pub fn complete(&self, id: Uuid, result: serde_json::Value) -> Result<PendingScan> {
        let mut scan = self.read_metadata(id)?;
        if scan.state != ScanState::Claimed {
            return Err(DesktopError::Mcp(
                "scan must be claimed before completion".to_string(),
            ));
        }
        scan.state = ScanState::Completed;
        scan.completed_result = Some(result);
        self.write_metadata(&scan)?;
        Ok(scan)
    }

    pub fn finish_completed(&self, id: Uuid) -> Result<()> {
        let scan = self.read_metadata(id)?;
        if scan.state != ScanState::Completed {
            return Err(DesktopError::Mcp("scan is not complete".to_string()));
        }
        self.delete_scan(&scan)
    }

    fn read_metadata(&self, id: Uuid) -> Result<PendingScan> {
        let path = self.metadata_path(id);
        if !path.is_file() {
            return Err(DesktopError::InvalidPath(path));
        }
        let scan = self.read_metadata_path(&path)?;
        if scan.id != id {
            return Err(DesktopError::InvalidImage(
                "scan metadata identifier does not match its file".to_string(),
            ));
        }
        Ok(scan)
    }

    fn read_metadata_path(&self, path: &Path) -> Result<PendingScan> {
        Ok(serde_json::from_slice(&std::fs::read(path)?)?)
    }

    fn write_metadata(&self, scan: &PendingScan) -> Result<()> {
        write_private(
            &self.metadata_path(scan.id),
            &serde_json::to_vec_pretty(scan)?,
        )
    }

    fn metadata_path(&self, id: Uuid) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }

    fn image_path(&self, id: Uuid, mime_type: &str) -> PathBuf {
        self.root.join(format!("{id}.{}", extension(mime_type)))
    }

    fn thumbnail_path(&self, id: Uuid) -> PathBuf {
        self.root.join(format!("{id}.preview.jpg"))
    }

    fn delete_scan(&self, scan: &PendingScan) -> Result<()> {
        let _lock = self.acquire_delete_lock()?;
        self.delete_scan_locked_with(
            scan,
            |source, tombstone| std::fs::rename(source, tombstone),
            |tombstone| std::fs::remove_file(tombstone),
        )
    }

    fn delete_scan_locked_with<R, C>(
        &self,
        scan: &PendingScan,
        mut rename: R,
        mut cleanup: C,
    ) -> Result<()>
    where
        R: FnMut(&Path, &Path) -> std::io::Result<()>,
        C: FnMut(&Path) -> std::io::Result<()>,
    {
        let mut journal = self.new_delete_journal(scan)?;
        self.write_delete_journal(&journal)?;
        for entry in &journal.entries {
            let (original, tombstone) = self.delete_entry_paths(entry)?;
            if let Err(error) = rename(&original, &tombstone) {
                let primary = DesktopError::Io(error);
                return Err(self.rollback_pending_journal(&journal, primary, &mut rename));
            }
            if let Err(error) = sync_directory(&self.root) {
                let primary = error;
                return Err(self.rollback_pending_journal(&journal, primary, &mut rename));
            }
        }
        journal.state = DeleteJournalState::Committed;
        if let Err(error) = self.write_delete_journal(&journal) {
            return Err(self.rollback_pending_journal(&journal, error, &mut rename));
        }
        let mut cleanup_complete = true;
        for entry in &journal.entries {
            let (_, tombstone) = self.delete_entry_paths(entry)?;
            if let Err(error) = cleanup(&tombstone) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    cleanup_complete = false;
                    tracing::warn!(
                        scan_id = %scan.id,
                        operation_id = %journal.operation_id,
                        file = entry.label,
                        error = %error,
                        "pending-delete tombstone cleanup deferred to startup"
                    );
                }
            }
        }
        if cleanup_complete {
            if let Err(error) = remove_if_exists(&self.delete_journal_path(journal.operation_id)) {
                tracing::warn!(
                    scan_id = %scan.id,
                    operation_id = %journal.operation_id,
                    error = %error,
                    "committed delete journal cleanup deferred to startup"
                );
            } else if let Err(error) = sync_directory(&self.root) {
                tracing::warn!(
                    scan_id = %scan.id,
                    operation_id = %journal.operation_id,
                    error = %error,
                    "committed delete journal durability check failed"
                );
            }
        }
        Ok(())
    }

    fn new_delete_journal(&self, scan: &PendingScan) -> Result<DeleteJournal> {
        let operation_id = Uuid::new_v4();
        let mut entries = Vec::new();
        for (label, original) in [
            ("capture", self.image_path(scan.id, &scan.mime_type)),
            ("preview", self.thumbnail_path(scan.id)),
            ("metadata", self.metadata_path(scan.id)),
        ] {
            if !original.exists() {
                continue;
            }
            let original = original
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| DesktopError::InvalidPath(original.clone()))?;
            let tombstone = format!(
                "{DELETE_TOMBSTONE_PREFIX}{operation_id}-{}-{label}.tombstone",
                scan.id
            );
            entries.push(DeleteEntry {
                label: label.to_string(),
                original: original.to_string(),
                tombstone,
            });
        }
        Ok(DeleteJournal {
            operation_id,
            scan_id: scan.id,
            state: DeleteJournalState::Pending,
            entries,
        })
    }

    fn delete_journal_path(&self, operation_id: Uuid) -> PathBuf {
        self.root.join(format!(
            "{DELETE_TOMBSTONE_PREFIX}{operation_id}.journal.json"
        ))
    }

    fn write_delete_journal(&self, journal: &DeleteJournal) -> Result<()> {
        let path = self.delete_journal_path(journal.operation_id);
        let temporary = path.with_extension("json.tmp");
        write_private(&temporary, &serde_json::to_vec_pretty(journal)?)?;
        std::fs::rename(temporary, path)?;
        sync_directory(&self.root)
    }

    fn delete_entry_paths(&self, entry: &DeleteEntry) -> Result<(PathBuf, PathBuf)> {
        Ok((
            self.root.join(validate_delete_filename(&entry.original)?),
            self.root.join(validate_delete_filename(&entry.tombstone)?),
        ))
    }

    fn rollback_pending_journal<R>(
        &self,
        journal: &DeleteJournal,
        primary: DesktopError,
        rename: &mut R,
    ) -> DesktopError
    where
        R: FnMut(&Path, &Path) -> std::io::Result<()>,
    {
        let mut failures = Vec::new();
        for entry in journal.entries.iter().rev() {
            let Ok((original, tombstone)) = self.delete_entry_paths(entry) else {
                failures.push(format!("{}: invalid journal path", entry.label));
                continue;
            };
            if !tombstone.exists() {
                if !original.exists() {
                    failures.push(format!(
                        "{}: original and tombstone are both missing",
                        entry.label
                    ));
                }
                continue;
            }
            if original.exists() {
                failures.push(format!(
                    "{}: original and tombstone both exist",
                    entry.label
                ));
                continue;
            }
            if let Err(error) = rename(&tombstone, &original) {
                failures.push(format!("{}: {error}", entry.label));
            }
        }
        if failures.is_empty() {
            if let Err(error) = remove_if_exists(&self.delete_journal_path(journal.operation_id)) {
                return DesktopError::Rollback {
                    operation: "pending delete staging",
                    primary: Box::new(primary),
                    cleanup: format!("journal: {error}"),
                };
            }
            if let Err(error) = sync_directory(&self.root) {
                return DesktopError::Rollback {
                    operation: "pending delete staging",
                    primary: Box::new(primary),
                    cleanup: format!("journal directory sync: {error}"),
                };
            }
            primary
        } else {
            DesktopError::Rollback {
                operation: "pending delete staging",
                primary: Box::new(primary),
                cleanup: failures.join("; "),
            }
        }
    }

    fn recover_delete_journals(&self) -> Result<usize> {
        if !self.root.exists() {
            return Ok(0);
        }
        let mut recovered = 0;
        for entry in std::fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with(DELETE_TOMBSTONE_PREFIX) || !name.ends_with(".journal.json") {
                continue;
            }
            let journal: DeleteJournal = serde_json::from_slice(&std::fs::read(entry.path())?)?;
            if entry.path() != self.delete_journal_path(journal.operation_id) {
                return Err(DesktopError::InvalidImage(
                    "pending-delete journal name does not match its operation".to_string(),
                ));
            }
            match journal.state {
                DeleteJournalState::Pending => {
                    let primary = DesktopError::InvalidImage(
                        "recovering interrupted pending delete".to_string(),
                    );
                    let error = self.rollback_pending_journal(
                        &journal,
                        primary,
                        &mut |tombstone, original| std::fs::rename(tombstone, original),
                    );
                    if matches!(error, DesktopError::Rollback { .. }) {
                        return Err(error);
                    }
                    tracing::warn!(
                        scan_id = %journal.scan_id,
                        operation_id = %journal.operation_id,
                        "restored an interrupted pending delete"
                    );
                }
                DeleteJournalState::Committed => {
                    let mut complete = true;
                    for delete_entry in &journal.entries {
                        let (original, tombstone) = self.delete_entry_paths(delete_entry)?;
                        if original.exists() {
                            return Err(DesktopError::InvalidImage(format!(
                                "committed delete {} still has an original {}",
                                journal.operation_id, delete_entry.label
                            )));
                        }
                        if let Err(error) = remove_if_exists(&tombstone) {
                            complete = false;
                            tracing::warn!(
                                scan_id = %journal.scan_id,
                                operation_id = %journal.operation_id,
                                file = %delete_entry.label,
                                error = %error,
                                "committed delete cleanup remains deferred"
                            );
                        }
                    }
                    if !complete {
                        continue;
                    }
                    remove_if_exists(&self.delete_journal_path(journal.operation_id))?;
                    sync_directory(&self.root)?;
                    tracing::info!(
                        scan_id = %journal.scan_id,
                        operation_id = %journal.operation_id,
                        "finished committed delete cleanup"
                    );
                }
            }
            recovered += 1;
        }
        Ok(recovered)
    }

    fn try_delete_lock(&self) -> Result<Option<DeleteLock>> {
        std::fs::create_dir_all(&self.root)?;
        let connection = rusqlite::Connection::open(self.root.join(DELETE_LOCK_DATABASE))?;
        connection.busy_timeout(Duration::ZERO)?;
        match connection.execute_batch("BEGIN EXCLUSIVE") {
            Ok(()) => Ok(Some(DeleteLock { connection })),
            Err(error)
                if matches!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
                ) =>
            {
                Ok(None)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn acquire_delete_lock(&self) -> Result<DeleteLock> {
        self.try_delete_lock()?.ok_or_else(|| {
            DesktopError::InvalidImage(
                "pending scan deletion is already running in another process".to_string(),
            )
        })
    }
}

fn normalize_mime(value: &str) -> &str {
    match value.trim().to_ascii_lowercase().as_str() {
        "image/jpg" | "image/jpeg" => "image/jpeg",
        "image/png" => "image/png",
        "image/webp" => "image/webp",
        "image/heif" | "image/heic" => "image/heic",
        _ => "",
    }
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if matches!(brand, b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1") {
            return Some("image/heic");
        }
    }
    None
}

fn extension(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/heic" => "heic",
        _ => "bin",
    }
}

fn remove_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn rollback_save(
    operation: &'static str,
    primary: DesktopError,
    files: &[(&str, &Path)],
) -> DesktopError {
    let cleanup = files
        .iter()
        .filter_map(|(label, path)| {
            remove_if_exists(path)
                .err()
                .map(|error| format!("{label}: {error}"))
        })
        .collect::<Vec<_>>();
    if cleanup.is_empty() {
        primary
    } else {
        DesktopError::Rollback {
            operation,
            primary: Box::new(primary),
            cleanup: cleanup.join("; "),
        }
    }
}

fn validate_delete_filename(value: &str) -> Result<&str> {
    let path = Path::new(value);
    if path.components().count() == 1
        && matches!(
            path.components().next(),
            Some(std::path::Component::Normal(_))
        )
    {
        Ok(value)
    } else {
        Err(DesktopError::InvalidImage(
            "pending-delete journal contains an invalid filename".to_string(),
        ))
    }
}

fn sync_directory(path: &Path) -> Result<()> {
    std::fs::File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn webp() -> Vec<u8> {
        b"RIFF\x04\x00\x00\x00WEBPdata".to_vec()
    }

    fn preview() -> Vec<u8> {
        b"\xff\xd8\xffpreview".to_vec()
    }

    #[test]
    fn camera_and_file_captures_use_the_same_pending_inbox() {
        let root = tempdir().expect("temp dir");
        let inbox = PendingInbox::new(root.path().join("inbox"));
        let first = inbox
            .save(&webp(), &preview(), "image/webp", CaptureSource::Camera)
            .expect("camera capture");
        let second = inbox
            .save(&webp(), &preview(), "image/webp", CaptureSource::File)
            .expect("file capture");

        let scans = inbox.list().expect("list scans");
        assert_eq!(scans.len(), 2);
        assert_eq!(
            inbox.read_image(first.id).expect("image").data,
            "UklGRgQAAABXRUJQZGF0YQ=="
        );
        assert!(inbox
            .preview_path(first.id)
            .expect("preview path")
            .is_file());
        inbox.delete(second.id).expect("delete scan");
        assert_eq!(inbox.list().expect("list scans").len(), 1);
    }

    #[test]
    fn declared_type_must_match_magic_bytes() {
        let root = tempdir().expect("temp dir");
        let inbox = PendingInbox::new(root.path().join("inbox"));
        let error = inbox
            .save(&webp(), &preview(), "image/png", CaptureSource::File)
            .expect_err("mismatched type");
        assert!(error.to_string().contains("does not match"));
    }

    #[test]
    fn rollback_removes_written_files_and_preserves_the_primary_error() {
        let root = tempdir().expect("temp dir");
        let capture = root.path().join("capture.webp");
        std::fs::write(&capture, webp()).expect("capture");

        let error = rollback_save(
            "pending preview write",
            DesktopError::InvalidImage("preview failed".to_string()),
            &[("capture", capture.as_path())],
        );

        assert!(matches!(error, DesktopError::InvalidImage(_)));
        assert!(!capture.exists());
    }

    #[test]
    fn rollback_aggregates_every_cleanup_failure() {
        let root = tempdir().expect("temp dir");
        let capture = root.path().join("capture.webp");
        let preview = root.path().join("capture.preview.jpg");
        std::fs::create_dir(&capture).expect("capture directory");
        std::fs::create_dir(&preview).expect("preview directory");

        let error = rollback_save(
            "pending metadata write",
            DesktopError::InvalidImage("metadata failed".to_string()),
            &[
                ("preview", preview.as_path()),
                ("capture", capture.as_path()),
            ],
        );
        let message = error.to_string();

        assert!(matches!(error, DesktopError::Rollback { .. }));
        assert!(message.contains("metadata failed"));
        assert!(message.contains("preview: I/O error"));
        assert!(message.contains("capture: I/O error"));
    }

    #[test]
    fn delete_rolls_back_every_staged_file_when_a_later_rename_fails() {
        for failed_stage in 1..=3 {
            let root = tempdir().expect("temp dir");
            let inbox = PendingInbox::new(root.path().join("inbox"));
            let scan = inbox
                .save(&webp(), &preview(), "image/webp", CaptureSource::File)
                .expect("scan");
            let mut stage = 0;
            let _lock = inbox.acquire_delete_lock().expect("delete lock");

            let error = inbox
                .delete_scan_locked_with(
                    &scan,
                    |source, tombstone| {
                        stage += 1;
                        if stage == failed_stage {
                            return Err(std::io::Error::other(format!(
                                "injected stage {failed_stage} failure"
                            )));
                        }
                        std::fs::rename(source, tombstone)
                    },
                    |tombstone| std::fs::remove_file(tombstone),
                )
                .expect_err("staging failure");

            assert!(error.to_string().contains(&format!("stage {failed_stage}")));
            assert!(inbox.image_path(scan.id, &scan.mime_type).is_file());
            assert!(inbox.thumbnail_path(scan.id).is_file());
            assert!(inbox.metadata_path(scan.id).is_file());
            assert_eq!(inbox.list().expect("list after rollback"), vec![scan]);
            assert_eq!(inbox.recover_delete_journals().expect("no journals"), 0);
        }
    }

    #[test]
    fn startup_finishes_cleanup_for_a_committed_delete() {
        let root = tempdir().expect("temp dir");
        let inbox_root = root.path().join("inbox");
        let inbox = PendingInbox::new(inbox_root.clone());
        let scan = inbox
            .save(&webp(), &preview(), "image/webp", CaptureSource::Camera)
            .expect("scan");
        let mut cleanup = 0;
        let delete_lock = inbox.acquire_delete_lock().expect("delete lock");

        inbox
            .delete_scan_locked_with(
                &scan,
                |source, tombstone| std::fs::rename(source, tombstone),
                |tombstone| {
                    cleanup += 1;
                    if cleanup == 1 {
                        Err(std::io::Error::other("injected cleanup failure"))
                    } else {
                        std::fs::remove_file(tombstone)
                    }
                },
            )
            .expect("logical deletion succeeds");
        drop(delete_lock);

        assert!(inbox.list().expect("scan is logically gone").is_empty());
        assert_eq!(
            std::fs::read_dir(&inbox_root)
                .expect("inbox")
                .filter_map(|entry| entry.ok())
                .filter(|entry| { entry.file_name().to_string_lossy().ends_with(".tombstone") })
                .count(),
            1
        );
        let restarted = PendingInbox::new(inbox_root);
        assert_eq!(
            restarted.recover_delete_journals().expect("clean restart"),
            0
        );
    }

    #[test]
    fn startup_rolls_back_a_pending_delete_after_every_rename_boundary() {
        for moved in 1..=3 {
            let root = tempdir().expect("temp dir");
            let inbox_root = root.path().join("inbox");
            let inbox = PendingInbox::new(inbox_root.clone());
            let scan = inbox
                .save(&webp(), &preview(), "image/webp", CaptureSource::File)
                .expect("scan");
            let delete_lock = inbox.acquire_delete_lock().expect("delete lock");
            let journal = inbox.new_delete_journal(&scan).expect("journal");
            inbox
                .write_delete_journal(&journal)
                .expect("pending journal");
            for entry in journal.entries.iter().take(moved) {
                let (original, tombstone) = inbox.delete_entry_paths(entry).expect("paths");
                std::fs::rename(original, tombstone).expect("stage rename");
                sync_directory(&inbox.root).expect("durable rename");
            }
            drop(delete_lock);

            let restarted = PendingInbox::new(inbox_root);
            assert!(restarted.image_path(scan.id, &scan.mime_type).is_file());
            assert!(restarted.thumbnail_path(scan.id).is_file());
            assert!(restarted.metadata_path(scan.id).is_file());
            assert_eq!(restarted.list().expect("restored scan"), vec![scan]);
            assert_eq!(restarted.recover_delete_journals().expect("no journal"), 0);
        }
    }

    #[test]
    fn startup_finalizes_a_committed_journal_after_a_crash() {
        let root = tempdir().expect("temp dir");
        let inbox_root = root.path().join("inbox");
        let inbox = PendingInbox::new(inbox_root.clone());
        let scan = inbox
            .save(&webp(), &preview(), "image/webp", CaptureSource::Camera)
            .expect("scan");
        let delete_lock = inbox.acquire_delete_lock().expect("delete lock");
        let mut journal = inbox.new_delete_journal(&scan).expect("journal");
        inbox
            .write_delete_journal(&journal)
            .expect("pending journal");
        for entry in &journal.entries {
            let (original, tombstone) = inbox.delete_entry_paths(entry).expect("paths");
            std::fs::rename(original, tombstone).expect("stage rename");
        }
        sync_directory(&inbox.root).expect("durable staging");
        journal.state = DeleteJournalState::Committed;
        inbox
            .write_delete_journal(&journal)
            .expect("committed journal");
        drop(delete_lock);

        let restarted = PendingInbox::new(inbox_root);
        assert!(restarted.list().expect("deleted scan").is_empty());
        assert!(!restarted.image_path(scan.id, &scan.mime_type).exists());
        assert!(!restarted.thumbnail_path(scan.id).exists());
        assert!(!restarted.metadata_path(scan.id).exists());
        assert_eq!(restarted.recover_delete_journals().expect("no journal"), 0);
    }

    #[test]
    fn delete_lock_holder() {
        let Ok(root) = std::env::var("POKEDEX_TEST_DELETE_LOCK_ROOT") else {
            return;
        };
        let ready =
            PathBuf::from(std::env::var("POKEDEX_TEST_DELETE_LOCK_READY").expect("ready marker"));
        let release = PathBuf::from(
            std::env::var("POKEDEX_TEST_DELETE_LOCK_RELEASE").expect("release marker"),
        );
        std::fs::create_dir_all(&root).expect("inbox root");
        let connection = rusqlite::Connection::open(Path::new(&root).join(DELETE_LOCK_DATABASE))
            .expect("lock DB");
        connection
            .execute_batch("BEGIN EXCLUSIVE")
            .expect("exclusive lock");
        std::fs::write(&ready, b"ready").expect("ready marker");
        while !release.exists() {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn second_process_cannot_scavenge_an_inflight_delete() {
        let temp = tempdir().expect("temp dir");
        let inbox_root = temp.path().join("inbox");
        let inbox = PendingInbox::new(inbox_root.clone());
        let scan = inbox
            .save(&webp(), &preview(), "image/webp", CaptureSource::File)
            .expect("scan");
        let delete_lock = inbox.acquire_delete_lock().expect("delete lock");
        let journal = inbox.new_delete_journal(&scan).expect("journal");
        inbox
            .write_delete_journal(&journal)
            .expect("pending journal");
        let (capture, capture_tombstone) = inbox
            .delete_entry_paths(&journal.entries[0])
            .expect("capture paths");
        std::fs::rename(&capture, &capture_tombstone).expect("first staging rename");
        sync_directory(&inbox.root).expect("durable rename");
        drop(delete_lock);

        let ready = temp.path().join("ready");
        let release = temp.path().join("release");
        let mut child = std::process::Command::new(std::env::current_exe().expect("test binary"))
            .arg("--exact")
            .arg("inbox::tests::delete_lock_holder")
            .arg("--nocapture")
            .env("POKEDEX_TEST_DELETE_LOCK_ROOT", &inbox_root)
            .env("POKEDEX_TEST_DELETE_LOCK_READY", &ready)
            .env("POKEDEX_TEST_DELETE_LOCK_RELEASE", &release)
            .spawn()
            .expect("lock-holder process");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !ready.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "lock holder became ready");

        let _second_process = PendingInbox::new(inbox_root.clone());
        assert!(!capture.exists());
        assert!(capture_tombstone.exists());
        assert!(inbox.delete_journal_path(journal.operation_id).is_file());

        std::fs::write(&release, b"release").expect("release marker");
        assert!(child.wait().expect("child exit").success());
        let recovered = PendingInbox::new(inbox_root);
        assert!(recovered.image_path(scan.id, &scan.mime_type).is_file());
        assert_eq!(recovered.list().expect("restored scan"), vec![scan]);
    }

    #[test]
    fn uuid_identifiers_cannot_traverse_the_inbox() {
        assert!(Uuid::parse_str("../../outside").is_err());
    }

    #[test]
    fn malformed_metadata_is_quarantined_without_hiding_valid_scans() {
        let root = tempdir().expect("temp dir");
        let inbox = PendingInbox::new(root.path().join("inbox"));
        let valid = inbox
            .save(&webp(), &preview(), "IMAGE/WEBP", CaptureSource::File)
            .expect("valid scan");
        std::fs::write(inbox.root.join("broken.json"), b"not json").expect("broken metadata");

        let scans = inbox.list().expect("list scans");
        assert_eq!(scans.len(), 1);
        assert_eq!(scans[0].id, valid.id);
        assert!(inbox.root.join("broken.json.invalid").is_file());
    }

    #[test]
    fn claim_and_completion_persist_one_mutation_identity() {
        let root = tempdir().expect("temp dir");
        let inbox = PendingInbox::new(root.path().join("inbox"));
        let scan = inbox
            .save(&webp(), &preview(), "image/webp", CaptureSource::Camera)
            .expect("scan");
        let claimed = inbox.claim(scan.id, "card-1").expect("claim");
        assert_eq!(claimed.mutation_id, scan.mutation_id);
        assert_eq!(claimed.state, ScanState::Claimed);
        let completed = inbox
            .complete(scan.id, serde_json::json!({ "ok": true }))
            .expect("complete");
        assert_eq!(completed.mutation_id, scan.mutation_id);
        assert_eq!(completed.state, ScanState::Completed);
        assert_eq!(
            inbox
                .claim(scan.id, "card-1")
                .expect("resume")
                .completed_result,
            Some(serde_json::json!({ "ok": true }))
        );
    }
}
