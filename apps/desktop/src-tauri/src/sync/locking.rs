use super::wait_for_cancellation;
use crate::error::{DesktopError, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, LazyLock, Mutex as StdMutex, Weak};
use std::time::Duration;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

static SYNC_LOCKS: LazyLock<StdMutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));
pub(super) const SYNC_LOCK_DATABASE: &str = ".pokedex-sync-lock.sqlite3";

fn process_sync_lock(root: &Path) -> Arc<AsyncMutex<()>> {
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

pub(super) struct SyncGuard {
    _process: OwnedMutexGuard<()>,
    _filesystem: rusqlite::Connection,
}

fn filesystem_sync_lock(root: &Path) -> Result<rusqlite::Connection> {
    let connection = rusqlite::Connection::open(root.join(SYNC_LOCK_DATABASE))?;
    connection.busy_timeout(Duration::ZERO)?;
    match connection.execute_batch("BEGIN EXCLUSIVE") {
        Ok(()) => Ok(connection),
        Err(error)
            if matches!(
                error.sqlite_error_code(),
                Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
            ) =>
        {
            Err(DesktopError::InvalidImage(
                "art synchronization is already running for this library".to_string(),
            ))
        }
        Err(error) => Err(error.into()),
    }
}

pub(super) async fn acquire_sync_lock(
    root: &Path,
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<SyncGuard> {
    let canonical_root = root.canonicalize()?;
    let lock = process_sync_lock(&canonical_root);
    let Some(cancellation) = cancellation else {
        let process = lock.lock_owned().await;
        return Ok(SyncGuard {
            _process: process,
            _filesystem: filesystem_sync_lock(&canonical_root)?,
        });
    };
    let process = tokio::select! {
        biased;
        () = wait_for_cancellation(cancellation) => return Err(DesktopError::Cancelled),
        guard = lock.lock_owned() => guard,
    };
    Ok(SyncGuard {
        _process: process,
        _filesystem: filesystem_sync_lock(&canonical_root)?,
    })
}
