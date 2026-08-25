use super::{remove_if_exists, PendingInbox, PendingScan};
use crate::config::write_private;
use crate::error::{DesktopError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const DELETE_TOMBSTONE_PREFIX: &str = ".pokedex-delete-";
const DELETE_LOCK_DATABASE: &str = ".pokedex-delete-lock.sqlite3";
const SCAN_LOCK_PREFIX: &str = ".pokedex-scan-";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct DeleteEntry {
    label: String,
    original: String,
    tombstone: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum DeleteJournalState {
    // Pending always means restore. Only a durably replaced Committed journal authorizes cleanup.
    Pending,
    Committed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct DeleteJournal {
    operation_id: Uuid,
    scan_id: Uuid,
    capture_mime_type: String,
    capture_original: String,
    state: DeleteJournalState,
    entries: Vec<DeleteEntry>,
}

struct DeleteLock {
    connection: rusqlite::Connection,
}

pub(crate) struct ScanTransaction<'a> {
    inbox: &'a PendingInbox,
    scan_id: Uuid,
    _lock: DeleteLock,
}

#[derive(Debug, Default)]
struct DeleteRecoveryReport {
    recovered: usize,
    promoted: usize,
    quarantined: usize,
    deferred: usize,
    diagnostics: Vec<String>,
}

enum JournalRecovery {
    Recovered,
    Deferred(String),
    Quarantine(String),
}

impl Drop for DeleteLock {
    fn drop(&mut self) {
        let _ = self.connection.execute_batch("ROLLBACK");
    }
}

pub(super) fn is_delete_artifact(path: &Path) -> bool {
    path.file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.starts_with(DELETE_TOMBSTONE_PREFIX))
}

impl PendingInbox {
    pub(crate) fn begin_scan_transaction(&self, scan_id: Uuid) -> Result<ScanTransaction<'_>> {
        Ok(ScanTransaction {
            inbox: self,
            scan_id,
            _lock: self.acquire_scan_lock(scan_id)?,
        })
    }

    pub(super) fn recover_deletes_at_startup(&self) {
        match self.try_delete_lock() {
            Ok(Some(_lock)) => match self.recover_delete_journals() {
                Ok(report) if !report.diagnostics.is_empty() => tracing::warn!(
                    recovered = report.recovered,
                    promoted = report.promoted,
                    quarantined = report.quarantined,
                    deferred = report.deferred,
                    diagnostics = %report.diagnostics.join(" | "),
                    "pending-delete recovery completed with retained diagnostics"
                ),
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(error = %error, "could not scan pending-delete journals")
                }
            },
            Ok(None) => tracing::debug!(
                "pending-delete recovery skipped because another process holds the lock"
            ),
            Err(error) => tracing::warn!(
                error = %error,
                "could not acquire the pending-delete recovery lock"
            ),
        }
    }

    fn delete_scan_locked(&self, scan: &PendingScan) -> Result<()> {
        let _delete_lock = self.acquire_delete_lock()?;
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
        let capture_path = self.image_path(scan.id, &scan.mime_type);
        let capture_original = capture_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| DesktopError::InvalidPath(capture_path.clone()))?
            .to_string();
        let mut entries = Vec::new();
        for (label, original) in [
            ("capture", capture_path),
            ("preview", self.thumbnail_path(scan.id)),
            ("metadata", self.metadata_path(scan.id)),
        ] {
            if !original.is_file() {
                return Err(DesktopError::InvalidImage(format!(
                    "pending scan is missing its required {label} file"
                )));
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
            capture_mime_type: scan.mime_type.clone(),
            capture_original,
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

    fn recover_delete_journals(&self) -> Result<DeleteRecoveryReport> {
        if !self.root.exists() {
            return Ok(DeleteRecoveryReport::default());
        }
        let mut report = DeleteRecoveryReport::default();
        let temporary = self.delete_journal_paths(".journal.json.tmp", &mut report)?;
        for path in temporary {
            let name = delete_file_name(&path);
            match self.read_delete_journal(&path, true) {
                Ok(journal) => {
                    let final_path = self.delete_journal_path(journal.operation_id);
                    match std::fs::rename(&path, &final_path)
                        .and_then(|()| sync_directory(&self.root).map_err(desktop_error_to_io))
                    {
                        Ok(()) => report.promoted += 1,
                        Err(error) => {
                            report.deferred += 1;
                            report.diagnostics.push(format!(
                                "{name}: temporary journal promotion failed: {error}"
                            ));
                        }
                    }
                }
                Err(error) => {
                    report.quarantined += 1;
                    report.diagnostics.push(format!("{name}: {error}"));
                    if let Err(quarantine_error) = self.quarantine_delete_journal(&path) {
                        report.diagnostics.push(format!(
                            "{name}: malformed temporary journal could not be quarantined: {quarantine_error}"
                        ));
                    }
                }
            }
        }

        let journals = self.delete_journal_paths(".journal.json", &mut report)?;
        for path in journals {
            let name = delete_file_name(&path);
            let journal = match self.read_delete_journal(&path, false) {
                Ok(journal) => journal,
                Err(error) => {
                    report.quarantined += 1;
                    report.diagnostics.push(format!("{name}: {error}"));
                    if let Err(quarantine_error) = self.quarantine_delete_journal(&path) {
                        report.diagnostics.push(format!(
                            "{name}: malformed final journal could not be quarantined: {quarantine_error}"
                        ));
                    }
                    continue;
                }
            };
            match self.recover_delete_journal(&journal) {
                JournalRecovery::Recovered => report.recovered += 1,
                JournalRecovery::Deferred(reason) => {
                    report.deferred += 1;
                    report.diagnostics.push(format!(
                        "scan {} operation {}: {reason}",
                        journal.scan_id, journal.operation_id
                    ));
                }
                JournalRecovery::Quarantine(reason) => {
                    report.quarantined += 1;
                    report.diagnostics.push(format!(
                        "scan {} operation {}: {reason}",
                        journal.scan_id, journal.operation_id
                    ));
                    if let Err(error) = self.quarantine_delete_journal(&path) {
                        report.diagnostics.push(format!(
                            "scan {} operation {}: ambiguous journal could not be quarantined: {error}",
                            journal.scan_id, journal.operation_id
                        ));
                    }
                }
            }
        }
        Ok(report)
    }

    fn delete_journal_paths(
        &self,
        suffix: &str,
        report: &mut DeleteRecoveryReport,
    ) -> Result<Vec<PathBuf>> {
        let entries = std::fs::read_dir(&self.root)?.map(|entry| entry.map(|entry| entry.path()));
        Ok(collect_delete_journal_paths(entries, suffix, report))
    }

    fn read_delete_journal(&self, path: &Path, temporary: bool) -> Result<DeleteJournal> {
        let journal: DeleteJournal = serde_json::from_slice(&std::fs::read(path)?)?;
        let expected = if temporary {
            self.delete_journal_path(journal.operation_id)
                .with_extension("json.tmp")
        } else {
            self.delete_journal_path(journal.operation_id)
        };
        if path != expected {
            return Err(DesktopError::InvalidImage(
                "pending-delete journal name does not match its operation".to_string(),
            ));
        }
        self.validate_delete_journal(&journal)?;
        Ok(journal)
    }

    fn validate_delete_journal(&self, journal: &DeleteJournal) -> Result<()> {
        if journal.entries.is_empty() {
            return Err(DesktopError::InvalidImage(
                "pending-delete journal has no files".to_string(),
            ));
        }
        let mut labels = HashSet::new();
        if !matches!(
            journal.capture_mime_type.as_str(),
            "image/jpeg" | "image/png" | "image/webp" | "image/heic"
        ) {
            return Err(DesktopError::InvalidImage(
                "pending-delete journal contains an invalid capture MIME type".to_string(),
            ));
        }
        let expected_capture = format!(
            "{}.{}",
            journal.scan_id,
            super::extension(&journal.capture_mime_type)
        );
        if journal.capture_original != expected_capture {
            return Err(DesktopError::InvalidImage(
                "pending-delete journal capture identity does not match its MIME type".to_string(),
            ));
        }
        for entry in &journal.entries {
            if !labels.insert(entry.label.as_str()) {
                return Err(DesktopError::InvalidImage(
                    "pending-delete journal contains a duplicate file label".to_string(),
                ));
            }
            self.delete_entry_paths(entry)?;
            let valid_original = match entry.label.as_str() {
                "capture" => entry.original == journal.capture_original,
                "preview" => entry.original == format!("{}.preview.jpg", journal.scan_id),
                "metadata" => entry.original == format!("{}.json", journal.scan_id),
                _ => {
                    return Err(DesktopError::InvalidImage(
                        "pending-delete journal contains an unknown file label".to_string(),
                    ));
                }
            };
            if !valid_original {
                return Err(DesktopError::InvalidImage(
                    "pending-delete journal file does not belong to its scan".to_string(),
                ));
            }
            let expected = format!(
                "{DELETE_TOMBSTONE_PREFIX}{}-{}-{}.tombstone",
                journal.operation_id, journal.scan_id, entry.label
            );
            if entry.tombstone != expected {
                return Err(DesktopError::InvalidImage(
                    "pending-delete tombstone does not match its journal".to_string(),
                ));
            }
        }
        let required = HashSet::from(["capture", "preview", "metadata"]);
        if labels != required {
            return Err(DesktopError::InvalidImage(
                "pending-delete journal does not contain the required file set".to_string(),
            ));
        }
        Ok(())
    }

    fn recover_delete_journal(&self, journal: &DeleteJournal) -> JournalRecovery {
        let mut paths = Vec::new();
        for entry in &journal.entries {
            let Ok((original, tombstone)) = self.delete_entry_paths(entry) else {
                return JournalRecovery::Quarantine(format!(
                    "{} contains an invalid path",
                    entry.label
                ));
            };
            paths.push((entry, original, tombstone));
        }
        let Some((_, metadata_original, metadata_tombstone)) =
            paths.iter().find(|(entry, _, _)| entry.label == "metadata")
        else {
            return JournalRecovery::Quarantine(
                "journal is missing its metadata identity anchor".to_string(),
            );
        };
        let persisted_metadata = if metadata_original.exists() {
            Some(metadata_original)
        } else if metadata_tombstone.exists() {
            Some(metadata_tombstone)
        } else {
            None
        };
        if let Some(metadata_path) = persisted_metadata {
            let scan = match self.read_metadata_path(metadata_path) {
                Ok(scan) => scan,
                Err(error) => {
                    return JournalRecovery::Quarantine(format!(
                        "persisted metadata identity is invalid: {error}"
                    ));
                }
            };
            let persisted_capture = format!("{}.{}", scan.id, super::extension(&scan.mime_type));
            if scan.id != journal.scan_id
                || scan.mime_type != journal.capture_mime_type
                || persisted_capture != journal.capture_original
            {
                return JournalRecovery::Quarantine(
                    "journal capture identity disagrees with persisted metadata".to_string(),
                );
            }
        } else if journal.state == DeleteJournalState::Pending {
            return JournalRecovery::Quarantine(
                "pending journal has no persisted metadata identity".to_string(),
            );
        }
        match journal.state {
            DeleteJournalState::Pending => {
                for (entry, original, tombstone) in &paths {
                    match (original.exists(), tombstone.exists()) {
                        (true, false) | (false, true) => {}
                        (true, true) => {
                            return JournalRecovery::Quarantine(format!(
                                "pending {} has both original and tombstone",
                                entry.label
                            ));
                        }
                        (false, false) => {
                            return JournalRecovery::Quarantine(format!(
                                "pending {} has neither original nor tombstone",
                                entry.label
                            ));
                        }
                    }
                }
                for (entry, original, tombstone) in paths.iter().rev() {
                    if !tombstone.exists() {
                        continue;
                    }
                    if let Err(error) = std::fs::rename(tombstone, original) {
                        return JournalRecovery::Deferred(format!(
                            "pending {} restore failed: {error}",
                            entry.label
                        ));
                    }
                }
                if let Err(error) =
                    remove_if_exists(&self.delete_journal_path(journal.operation_id))
                        .and_then(|()| sync_directory(&self.root))
                {
                    return JournalRecovery::Deferred(format!(
                        "pending journal cleanup failed: {error}"
                    ));
                }
                tracing::warn!(scan_id=%journal.scan_id,operation_id=%journal.operation_id,"restored an interrupted pending delete");
                JournalRecovery::Recovered
            }
            DeleteJournalState::Committed => {
                if let Some((entry, _, _)) = paths.iter().find(|(_, original, _)| original.exists())
                {
                    return JournalRecovery::Quarantine(format!(
                        "committed {} still has its original",
                        entry.label
                    ));
                }
                for (entry, _, tombstone) in &paths {
                    if let Err(error) = remove_if_exists(tombstone) {
                        return JournalRecovery::Deferred(format!(
                            "committed {} cleanup failed: {error}",
                            entry.label
                        ));
                    }
                }
                if let Err(error) =
                    remove_if_exists(&self.delete_journal_path(journal.operation_id))
                        .and_then(|()| sync_directory(&self.root))
                {
                    return JournalRecovery::Deferred(format!(
                        "committed journal cleanup failed: {error}"
                    ));
                }
                tracing::info!(scan_id=%journal.scan_id,operation_id=%journal.operation_id,"finished committed delete cleanup");
                JournalRecovery::Recovered
            }
        }
    }

    fn quarantine_delete_journal(&self, path: &Path) -> Result<()> {
        let name = delete_file_name(path);
        let quarantine = self.root.join(format!("{name}.invalid-{}", Uuid::new_v4()));
        std::fs::rename(path, quarantine)?;
        sync_directory(&self.root)
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
                "pending scan transaction is already running in another process".to_string(),
            )
        })
    }

    fn acquire_scan_lock(&self, scan_id: Uuid) -> Result<DeleteLock> {
        std::fs::create_dir_all(&self.root)?;
        let connection = rusqlite::Connection::open(
            self.root
                .join(format!("{SCAN_LOCK_PREFIX}{scan_id}.lock.sqlite3")),
        )?;
        connection.busy_timeout(Duration::ZERO)?;
        match connection.execute_batch("BEGIN EXCLUSIVE") {
            Ok(()) => Ok(DeleteLock { connection }),
            Err(error)
                if matches!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
                ) =>
            {
                Err(DesktopError::InvalidImage(
                    "pending scan transaction is already running in another process".to_string(),
                ))
            }
            Err(error) => Err(error.into()),
        }
    }
}

impl ScanTransaction<'_> {
    pub(crate) fn claim(&self, card_id: &str) -> Result<PendingScan> {
        self.inbox.claim_unlocked(self.scan_id, card_id)
    }

    pub(crate) fn read_image(&self) -> Result<super::PendingScanImage> {
        self.inbox.read_image(self.scan_id)
    }

    pub(crate) fn complete(&self, result: serde_json::Value) -> Result<PendingScan> {
        self.inbox.complete_unlocked(self.scan_id, result)
    }

    pub(crate) fn delete_pending(&self) -> Result<()> {
        let scan = self.inbox.read_metadata(self.scan_id)?;
        if scan.state != super::ScanState::Pending {
            return Err(DesktopError::Mcp(
                "pending scan transaction cannot delete a claimed or completed scan".to_string(),
            ));
        }
        self.inbox.delete_scan_locked(&scan)
    }

    pub(crate) fn finish_completed(&self) -> Result<()> {
        let scan = self.inbox.read_metadata(self.scan_id)?;
        if scan.state != super::ScanState::Completed {
            return Err(DesktopError::Mcp("scan is not complete".to_string()));
        }
        self.inbox.delete_scan_locked(&scan)
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

fn delete_file_name(path: &Path) -> String {
    path.file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "unknown-journal".to_string())
}

fn collect_delete_journal_paths<I>(
    entries: I,
    suffix: &str,
    report: &mut DeleteRecoveryReport,
) -> Vec<PathBuf>
where
    I: IntoIterator<Item = std::io::Result<PathBuf>>,
{
    let mut paths = Vec::new();
    for entry in entries {
        let path = match entry {
            Ok(path) => path,
            Err(error) => {
                report.deferred += 1;
                report
                    .diagnostics
                    .push(format!("inbox directory entry could not be read: {error}"));
                continue;
            }
        };
        let name = delete_file_name(&path);
        if name.starts_with(DELETE_TOMBSTONE_PREFIX) && name.ends_with(suffix) {
            paths.push(path);
        }
    }
    paths.sort();
    paths
}

fn desktop_error_to_io(error: DesktopError) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

fn sync_directory(path: &Path) -> Result<()> {
    std::fs::File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests;
