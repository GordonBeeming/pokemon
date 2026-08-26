mod cloud;
mod config;
mod error;
mod inbox;
mod mcp;
mod secrets;
mod sync;

use crate::cloud::{ArtVariant, CloudClient, CollectionSetInput};
use crate::config::{AppConfig, AppPaths};
use crate::error::{DesktopError, Result};
use crate::inbox::{CaptureSource, PendingInbox, PendingScan, PendingScanImage, ScanState};
use crate::mcp::{McpBackend, McpStatus, ToolName, ToolPayload};
use crate::secrets::{DesktopTokenStore, KeychainTokenStore};
use crate::sync::{ArtSyncEngine, CloudArtRemote, SyncReport, TcgdexArtSource, UploadOutcome};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use tauri::Manager;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

const REQUIRED_SCOPES: [&str; 5] = [
    "catalogue:read",
    "art:read",
    "art:write",
    "collection:write",
    "binders:write",
];

#[cfg(test)]
type DeletePhasePause = (Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>);

struct DesktopServices {
    paths: AppPaths,
    config: RwLock<AppConfig>,
    inbox: PendingInbox,
    token_store: Arc<dyn DesktopTokenStore>,
    cloud: CloudClient,
    settings_lock: Mutex<()>,
    pairing_lock: Mutex<()>,
    sync_lock: Mutex<()>,
    delete_phase_lock: Arc<Mutex<()>>,
    scan_locks: StdMutex<HashMap<Uuid, Weak<Mutex<()>>>>,
    #[cfg(test)]
    scan_lock_contended: StdMutex<Option<Arc<tokio::sync::Notify>>>,
    #[cfg(test)]
    delete_phase_contended: StdMutex<Option<Arc<tokio::sync::Notify>>>,
    #[cfg(test)]
    delete_phase_pause: StdMutex<Option<DeletePhasePause>>,
    sync_cancel: Arc<AtomicBool>,
}

struct TauriState {
    services: Arc<DesktopServices>,
    mcp_status: Arc<RwLock<McpStatus>>,
    mcp_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    mcp_generation: Arc<AtomicU64>,
    mcp_token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStatus {
    config: AppConfig,
    paired: bool,
    pending_scans: Vec<PendingScan>,
    mcp: McpStatus,
}

impl DesktopServices {
    fn new(
        paths: AppPaths,
        config: AppConfig,
        token_store: Arc<dyn DesktopTokenStore>,
    ) -> Result<Self> {
        Ok(Self {
            inbox: PendingInbox::new(paths.inbox_dir.clone()),
            paths,
            config: RwLock::new(config),
            token_store,
            cloud: CloudClient::new()?,
            settings_lock: Mutex::new(()),
            pairing_lock: Mutex::new(()),
            sync_lock: Mutex::new(()),
            delete_phase_lock: Arc::new(Mutex::new(())),
            scan_locks: StdMutex::new(HashMap::new()),
            #[cfg(test)]
            scan_lock_contended: StdMutex::new(None),
            #[cfg(test)]
            delete_phase_contended: StdMutex::new(None),
            #[cfg(test)]
            delete_phase_pause: StdMutex::new(None),
            sync_cancel: Arc::new(AtomicBool::new(false)),
        })
    }

    fn cloud_token(&self, origin: &str) -> Result<String> {
        self.token_store.get(origin)?.ok_or(DesktopError::NotPaired)
    }

    fn handle_cloud<T>(&self, origin: &str, token: &str, result: Result<T>) -> Result<T> {
        if matches!(result, Err(DesktopError::Cloud { status: 401, .. })) {
            self.token_store.compare_delete(origin, token)?;
        }
        result
    }

    async fn cloud_context(&self) -> Result<(String, String)> {
        let config = self.config.read().await;
        let origin = config.cloud_base_url.clone();
        Ok((origin.clone(), self.cloud_token(&origin)?))
    }

    fn process_scan_lock(&self, scan_id: Uuid) -> Arc<Mutex<()>> {
        let mut locks = self
            .scan_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&scan_id).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(scan_id, Arc::downgrade(&lock));
        lock
    }

    async fn acquire_process_scan_lock(&self, scan_id: Uuid) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = self.process_scan_lock(scan_id);
        match lock.clone().try_lock_owned() {
            Ok(guard) => guard,
            Err(_) => {
                #[cfg(test)]
                if let Some(notify) = self
                    .scan_lock_contended
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .as_ref()
                {
                    notify.notify_one();
                }
                lock.lock_owned().await
            }
        }
    }

    async fn acquire_delete_phase_lock(&self) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = self.delete_phase_lock.clone();
        let guard = match lock.clone().try_lock_owned() {
            Ok(guard) => guard,
            Err(_) => {
                #[cfg(test)]
                if let Some(notify) = self
                    .delete_phase_contended
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .as_ref()
                {
                    notify.notify_one();
                }
                lock.lock_owned().await
            }
        };
        #[cfg(test)]
        let pause = self
            .delete_phase_pause
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        #[cfg(test)]
        if let Some((entered, release)) = pause {
            entered.notify_one();
            release.notified().await;
        }
        guard
    }
}

#[tauri::command]
async fn desktop_status(
    state: tauri::State<'_, TauriState>,
) -> std::result::Result<DesktopStatus, String> {
    let config = state.services.config.read().await.clone();
    let paired = state
        .services
        .token_store
        .get(&config.cloud_base_url)
        .map_err(display_error)?
        .is_some();
    Ok(DesktopStatus {
        config,
        paired,
        pending_scans: state.services.inbox.list().map_err(display_error)?,
        mcp: state.mcp_status.read().await.clone(),
    })
}

#[tauri::command]
async fn save_settings(
    state: tauri::State<'_, TauriState>,
    config: AppConfig,
) -> std::result::Result<AppConfig, String> {
    let _guard = state.services.settings_lock.lock().await;
    let previous = state.services.config.read().await.clone();
    config.validate().map_err(display_error)?;
    sync::validate_library_path(&config.image_library_path).map_err(display_error)?;
    let replacement = if previous.mcp_port != config.mcp_port {
        let generation = state.mcp_generation.load(Ordering::Acquire) + 1;
        let backend: Arc<dyn McpBackend> = state.services.clone();
        match mcp::start(
            config.mcp_port,
            state.mcp_token.clone(),
            backend,
            state.mcp_status.clone(),
            generation,
            state.mcp_generation.clone(),
        )
        .await
        {
            Ok((task, status)) => Some((task, status, generation)),
            Err(error) => return Err(display_error(error)),
        }
    } else {
        None
    };
    if let Err(error) = config::save(&state.services.paths.config_file, &config) {
        if let Some((task, _, _)) = replacement {
            task.abort();
        }
        return Err(display_error(error));
    }
    *state.services.config.write().await = config.clone();
    if let Some((replacement, status, generation)) = replacement {
        {
            let mut current_status = state.mcp_status.write().await;
            state.mcp_generation.store(generation, Ordering::Release);
            *current_status = status;
        }
        let previous_task = state.mcp_task.lock().await.replace(replacement);
        if let Some(task) = previous_task {
            task.abort();
        }
    }
    Ok(config)
}

#[tauri::command]
async fn redeem_pairing_code(
    state: tauri::State<'_, TauriState>,
    code: String,
) -> std::result::Result<Vec<String>, String> {
    state
        .services
        .pair_cloud(&code)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn disconnect_cloud(state: tauri::State<'_, TauriState>) -> std::result::Result<(), String> {
    state.services.disconnect().await.map_err(display_error)
}

#[tauri::command]
fn save_capture(
    state: tauri::State<'_, TauriState>,
    bytes: Vec<u8>,
    preview_bytes: Vec<u8>,
    mime_type: String,
    source: CaptureSource,
) -> std::result::Result<PendingScan, String> {
    state
        .services
        .inbox
        .save(&bytes, &preview_bytes, &mime_type, source)
        .map_err(display_error)
}

#[tauri::command]
fn pending_scan_preview_path(
    state: tauri::State<'_, TauriState>,
    scan_id: Uuid,
) -> std::result::Result<PathBuf, String> {
    state
        .services
        .inbox
        .preview_path(scan_id)
        .map_err(display_error)
}

#[tauri::command]
fn pending_scan_image(
    state: tauri::State<'_, TauriState>,
    scan_id: Uuid,
) -> std::result::Result<PendingScanImage, String> {
    state
        .services
        .inbox
        .read_image(scan_id)
        .map_err(display_error)
}

#[tauri::command]
async fn delete_pending_scan(
    state: tauri::State<'_, TauriState>,
    scan_id: Uuid,
) -> std::result::Result<(), String> {
    state
        .services
        .delete_scan(scan_id)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn synchronize_art(
    state: tauri::State<'_, TauriState>,
) -> std::result::Result<SyncReport, String> {
    let _guard = state
        .services
        .sync_lock
        .try_lock()
        .map_err(|_| "Art synchronization is already running.".to_string())?;
    state.services.sync_cancel.store(false, Ordering::Relaxed);
    let (base_url, token) = state
        .services
        .cloud_context()
        .await
        .map_err(display_error)?;
    let root = state
        .services
        .config
        .read()
        .await
        .image_library_path
        .clone();
    let remote = Arc::new(CloudArtRemote::new(
        state.services.cloud.clone(),
        base_url,
        token,
    ));
    ArtSyncEngine::with_source(
        root,
        remote,
        Arc::new(TcgdexArtSource::new().map_err(display_error)?),
    )
    .with_cancellation(state.services.sync_cancel.clone())
    .synchronize()
    .await
    .map_err(display_error)
}

#[tauri::command]
fn cancel_art_sync(state: tauri::State<'_, TauriState>) {
    state.services.sync_cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn upload_art_file(
    state: tauri::State<'_, TauriState>,
    card_id: String,
    variant: ArtVariant,
    path: PathBuf,
) -> std::result::Result<UploadOutcome, String> {
    let _guard = state.services.sync_lock.lock().await;
    let (base_url, token) = state
        .services
        .cloud_context()
        .await
        .map_err(display_error)?;
    let root = state
        .services
        .config
        .read()
        .await
        .image_library_path
        .clone();
    validate_upload_path(&root, &path).map_err(display_error)?;
    let remote = Arc::new(CloudArtRemote::new(
        state.services.cloud.clone(),
        base_url,
        token,
    ));
    ArtSyncEngine::new(root, remote)
        .upload_local(&card_id, variant, &path)
        .await
        .map_err(display_error)
}

fn validate_upload_path(root: &Path, candidate: &Path) -> Result<()> {
    let root = root.canonicalize()?;
    let candidate = candidate.canonicalize()?;
    if !candidate.is_file() || !candidate.starts_with(&root) {
        return Err(DesktopError::InvalidPath(candidate));
    }
    Ok(())
}

fn validate_pairing_page_url(value: &str) -> Result<()> {
    let url = url::Url::parse(value)?;
    let allowed = url.scheme() == "https"
        || (url.scheme() == "http"
            && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1")));
    if !allowed {
        return Err(DesktopError::InvalidConfig(
            "pairing page must use HTTPS or loopback HTTP".to_string(),
        ));
    }
    Ok(())
}

#[tauri::command]
fn open_pairing_page(url: String) -> std::result::Result<(), String> {
    validate_pairing_page_url(&url).map_err(display_error)?;
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| display_error(DesktopError::Io(error)))
}

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[async_trait]
impl McpBackend for DesktopServices {
    async fn call_tool(&self, name: ToolName, arguments: Value) -> Result<ToolPayload> {
        let arguments = object(arguments)?;
        match name {
            ToolName::CatalogueSearch => {
                let query = required_string(&arguments, "query", 200)?;
                let limit = optional_u64(&arguments, "limit")?
                    .unwrap_or(20)
                    .clamp(1, 100) as u16;
                let (base, token) = self.cloud_context().await?;
                let result = self
                    .cloud
                    .catalogue_search(&base, &token, query, limit)
                    .await;
                structured(self.handle_cloud(&base, &token, result)?)
            }
            ToolName::CardGet => {
                let card_id = required_string(&arguments, "cardId", 128)?;
                let (base, token) = self.cloud_context().await?;
                let result = self.cloud.card(&base, &token, card_id).await;
                structured(self.handle_cloud(&base, &token, result)?)
            }
            ToolName::BindersList => {
                let (base, token) = self.cloud_context().await?;
                let result = self.cloud.list_binders(&base, &token).await;
                structured(self.handle_cloud(&base, &token, result)?)
            }
            ToolName::BinderGet => {
                let version_id = required_string(&arguments, "versionId", 128)?;
                let (base, token) = self.cloud_context().await?;
                let result = self.cloud.binder(&base, &token, version_id).await;
                structured(self.handle_cloud(&base, &token, result)?)
            }
            ToolName::BinderSuggest => {
                let version_id = required_string(&arguments, "versionId", 128)?;
                let (base, token) = self.cloud_context().await?;
                let result = self
                    .cloud
                    .binder_suggestions(&base, &token, version_id)
                    .await;
                structured(self.handle_cloud(&base, &token, result)?)
            }
            ToolName::PendingScansList => Ok(ToolPayload::Structured(json!({
                "scans": self.inbox.list()?
            }))),
            ToolName::PendingScanImage => {
                let scan_id = required_uuid(&arguments, "scanId")?;
                let image = self.inbox.read_image(scan_id)?;
                Ok(ToolPayload::Image {
                    mime_type: image.mime_type,
                    base64_data: image.data,
                    metadata: json!({ "scanId": image.id }),
                })
            }
            ToolName::ConfirmScan => self.confirm_scan(&arguments).await,
            ToolName::CollectionSet => self.set_collection_tool(&arguments).await,
            ToolName::CollectionNotes => self.set_notes_tool(&arguments).await,
            ToolName::BinderCreateDraft => {
                let name = required_string(&arguments, "name", 120)?;
                let layout = arguments
                    .get("layout")
                    .cloned()
                    .ok_or_else(|| DesktopError::Mcp("layout is required".to_string()))?;
                let (base, token) = self.cloud_context().await?;
                let result = self.cloud.create_binder(&base, &token, name, layout).await;
                structured(self.handle_cloud(&base, &token, result)?)
            }
            ToolName::BinderSlotSet => {
                let version_id = required_string(&arguments, "versionId", 128)?;
                let expected_revision = required_u64(&arguments, "expectedRevision")?;
                let slot = json!({
                    "page": required_u64(&arguments, "page")?,
                    "row": required_u64(&arguments, "row")?,
                    "column": required_u64(&arguments, "column")?,
                    "cardId": optional_nullable_string(&arguments, "cardId", 128)?,
                });
                let (base, token) = self.cloud_context().await?;
                let result = self
                    .cloud
                    .set_binder_slot(&base, &token, version_id, slot, expected_revision)
                    .await;
                structured(self.handle_cloud(&base, &token, result)?)
            }
            ToolName::BinderSlotSwap => {
                let version_id = required_string(&arguments, "versionId", 128)?;
                let expected_revision = required_u64(&arguments, "expectedRevision")?;
                let source = arguments
                    .get("source")
                    .cloned()
                    .ok_or_else(|| DesktopError::Mcp("source is required".to_string()))?;
                let target = arguments
                    .get("target")
                    .cloned()
                    .ok_or_else(|| DesktopError::Mcp("target is required".to_string()))?;
                let (base, token) = self.cloud_context().await?;
                let result = self
                    .cloud
                    .swap_binder_slots(&base, &token, version_id, expected_revision, source, target)
                    .await;
                structured(self.handle_cloud(&base, &token, result)?)
            }
        }
    }
}

impl DesktopServices {
    async fn pair_cloud(&self, code: &str) -> Result<Vec<String>> {
        let _guard = self.pairing_lock.lock().await;
        let config = self.config.read().await.clone();
        let result = self
            .cloud
            .redeem_pairing_code(&config.cloud_base_url, code, &config.device_label)
            .await?;
        let missing = REQUIRED_SCOPES
            .iter()
            .filter(|scope| !result.scopes.iter().any(|granted| granted == **scope))
            .copied()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            return Err(DesktopError::InvalidCloudResponse(format!(
                "pairing token is missing required scopes: {}",
                missing.join(", ")
            )));
        }
        self.token_store
            .set(&config.cloud_base_url, &result.token)?;
        Ok(result.scopes)
    }

    async fn disconnect(&self) -> Result<()> {
        let _guard = self.pairing_lock.lock().await;
        let origin = self.config.read().await.cloud_base_url.clone();
        self.token_store.delete(&origin)
    }

    async fn confirm_scan(&self, arguments: &Map<String, Value>) -> Result<ToolPayload> {
        if arguments.get("confirmed").and_then(Value::as_bool) != Some(true) {
            return Err(DesktopError::Mcp(
                "confirmed must be true before the collection can change".to_string(),
            ));
        }
        let scan_id = required_uuid(arguments, "scanId")?;
        let card_id = required_string(arguments, "cardId", 128)?;
        let _process_guard = self.acquire_process_scan_lock(scan_id).await;
        let transaction = self.inbox.begin_scan_transaction(scan_id)?;
        let scan = transaction.read_scan()?;
        if scan.state != ScanState::Pending && scan.confirmed_card_id.as_deref() != Some(card_id) {
            return Err(DesktopError::Mcp(
                "scan is already claimed for a different card".to_string(),
            ));
        }
        if scan.state == ScanState::Completed {
            let completed = scan.completed_result.ok_or_else(|| {
                DesktopError::Mcp("completed scan is missing its stored result".to_string())
            })?;
            let _delete_guard = self.acquire_delete_phase_lock().await;
            finish_completed_with_diagnostics(scan.id, scan.mutation_id, true, || {
                transaction.finish_completed()
            })?;
            tracing::info!(
                target: "pokedex.scan",
                event = "scan.confirmation.completed",
                operation = "confirm_scan",
                scan_id = %scan.id,
                mutation_id = %scan.mutation_id,
                state = "completed",
                replayed = true,
                "completed scan confirmation finalized from its stored result"
            );
            return Ok(ToolPayload::Structured(completed));
        }
        if let Err(error) = transaction.read_image() {
            if scan.state == ScanState::Claimed {
                log_ambiguous_confirmation(&scan, &error);
            }
            return Err(error);
        }
        let (base, token) = match self.cloud_context().await {
            Ok(context) => context,
            Err(error) => {
                if scan.state == ScanState::Claimed {
                    log_ambiguous_confirmation(&scan, &error);
                }
                return Err(error);
            }
        };
        let claimed_this_call = scan.state == ScanState::Pending;
        let claimed = if claimed_this_call {
            transaction.claim(card_id)?
        } else {
            scan
        };
        let mutation = match self
            .cloud
            .increment_collection(&base, &token, card_id, 1, claimed.mutation_id)
            .await
        {
            Ok(mutation) => mutation,
            Err(error) => {
                let terminal = is_terminal_non_commit_confirmation(&error);
                let handled = self
                    .handle_cloud::<()>(&base, &token, Err(error))
                    .expect_err("cloud failure cannot produce a value");
                if terminal && claimed_this_call {
                    if let Err(reset_error) = transaction.reset_claim(card_id, claimed.mutation_id)
                    {
                        return Err(DesktopError::Rollback {
                            operation: "terminal scan confirmation",
                            primary: Box::new(handled),
                            cleanup: reset_error.to_string(),
                        });
                    }
                } else {
                    log_ambiguous_confirmation(&claimed, &handled);
                }
                return Err(handled);
            }
        };
        let replayed = mutation.replayed;
        let result = json!({
            "confirmedCardId": card_id,
            "collection": mutation,
            "deletedScanId": scan_id
        });
        transaction.complete(result.clone())?;
        let _delete_guard = self.acquire_delete_phase_lock().await;
        finish_completed_with_diagnostics(claimed.id, claimed.mutation_id, replayed, || {
            transaction.finish_completed()
        })?;
        tracing::info!(
            target: "pokedex.scan",
            event = "scan.confirmation.completed",
            operation = "confirm_scan",
            scan_id = %claimed.id,
            mutation_id = %claimed.mutation_id,
            state = "completed",
            replayed,
            "scan confirmation completed and local capture was finalized"
        );
        Ok(ToolPayload::Structured(result))
    }

    async fn delete_scan(&self, scan_id: Uuid) -> Result<()> {
        let _process_guard = self.acquire_process_scan_lock(scan_id).await;
        let transaction = self.inbox.begin_scan_transaction(scan_id)?;
        let _delete_guard = self.acquire_delete_phase_lock().await;
        transaction.delete_pending()
    }

    async fn set_collection_tool(&self, arguments: &Map<String, Value>) -> Result<ToolPayload> {
        let card_id = required_string(arguments, "cardId", 128)?;
        let quantity = required_u64(arguments, "quantity")?;
        if quantity > 9999 {
            return Err(DesktopError::Mcp(
                "quantity must be between 0 and 9999".to_string(),
            ));
        }
        let notes = optional_nullable_string(arguments, "notes", 2000)?;
        let expected_revision = required_u64(arguments, "expectedRevision")?;
        let (base, token) = self.cloud_context().await?;
        let result = self
            .cloud
            .set_collection(
                &base,
                &token,
                CollectionSetInput {
                    card_id,
                    quantity: quantity as u32,
                    notes: notes.as_deref(),
                    mutation_id: Uuid::new_v4(),
                    expected_revision,
                },
            )
            .await;
        Ok(ToolPayload::Structured(serde_json::to_value(
            self.handle_cloud(&base, &token, result)?,
        )?))
    }

    async fn set_notes_tool(&self, arguments: &Map<String, Value>) -> Result<ToolPayload> {
        let card_id = required_string(arguments, "cardId", 128)?;
        let notes = optional_nullable_string(arguments, "notes", 2000)?;
        let expected_revision = required_u64(arguments, "expectedRevision")?;
        let (base, token) = self.cloud_context().await?;
        let result = self
            .cloud
            .patch_collection_notes(
                &base,
                &token,
                card_id,
                notes.as_deref(),
                expected_revision,
                Uuid::new_v4(),
            )
            .await;
        Ok(ToolPayload::Structured(serde_json::to_value(
            self.handle_cloud(&base, &token, result)?,
        )?))
    }
}

fn is_terminal_non_commit_confirmation(error: &DesktopError) -> bool {
    matches!(
        error,
        DesktopError::Cloud { status, .. }
            if (400..500).contains(status) && !matches!(status, 408 | 429)
    )
}

fn desktop_error_class(error: &DesktopError) -> &'static str {
    match error {
        DesktopError::InvalidConfig(_) => "invalid_config",
        DesktopError::InvalidPath(_) => "invalid_path",
        DesktopError::InvalidImage(_) => "invalid_image",
        DesktopError::NotPaired => "not_paired",
        DesktopError::Cancelled => "cancelled",
        DesktopError::Cloud { .. } => "cloud",
        DesktopError::InvalidCloudResponse(_) => "invalid_cloud_response",
        DesktopError::ChecksumMismatch { .. } => "checksum_mismatch",
        DesktopError::Io(_) => "io",
        DesktopError::Rollback { .. } => "rollback",
        DesktopError::Json(_) => "json",
        DesktopError::Http(_) => "http",
        DesktopError::Url(_) => "url",
        DesktopError::Sqlite(_) => "sqlite",
        DesktopError::Keychain(_) => "keychain",
        DesktopError::Mcp(_) => "mcp",
    }
}

fn log_ambiguous_confirmation(scan: &PendingScan, error: &DesktopError) {
    tracing::warn!(
        target: "pokedex.scan",
        event = "scan.confirmation.retained",
        operation = "confirm_scan",
        scan_id = %scan.id,
        mutation_id = %scan.mutation_id,
        state = "claimed",
        retryable = true,
        error_class = desktop_error_class(error),
        "scan claim retained because the collection mutation outcome is ambiguous"
    );
}

fn log_completed_cleanup_failure(
    scan_id: Uuid,
    mutation_id: Uuid,
    replayed: bool,
    error: &DesktopError,
) {
    tracing::warn!(
        target: "pokedex.scan",
        event = "scan.confirmation.cleanup_failed",
        operation = "confirm_scan",
        scan_id = %scan_id,
        mutation_id = %mutation_id,
        state = "completed",
        replayed,
        phase = "local_cleanup",
        retryable = true,
        error_class = desktop_error_class(error),
        "collection mutation completed but local scan cleanup must be retried"
    );
}

fn finish_completed_with_diagnostics<F>(
    scan_id: Uuid,
    mutation_id: Uuid,
    replayed: bool,
    finish: F,
) -> Result<()>
where
    F: FnOnce() -> Result<()>,
{
    finish().inspect_err(|error| {
        log_completed_cleanup_failure(scan_id, mutation_id, replayed, error);
    })
}

fn object(value: Value) -> Result<Map<String, Value>> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| DesktopError::Mcp("arguments must be an object".to_string()))
}

fn structured(value: impl Serialize) -> Result<ToolPayload> {
    Ok(ToolPayload::Structured(serde_json::to_value(value)?))
}

fn required_string<'a>(
    arguments: &'a Map<String, Value>,
    name: &str,
    max: usize,
) -> Result<&'a str> {
    let value = arguments
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= max)
        .ok_or_else(|| DesktopError::Mcp(format!("{name} must contain 1 to {max} characters")))?;
    Ok(value)
}

fn required_uuid(arguments: &Map<String, Value>, name: &str) -> Result<Uuid> {
    Uuid::parse_str(required_string(arguments, name, 64)?)
        .map_err(|_| DesktopError::Mcp(format!("{name} must be a UUID")))
}

fn required_u64(arguments: &Map<String, Value>, name: &str) -> Result<u64> {
    arguments
        .get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| DesktopError::Mcp(format!("{name} must be a non-negative integer")))
}

fn optional_u64(arguments: &Map<String, Value>, name: &str) -> Result<Option<u64>> {
    match arguments.get(name) {
        None => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| DesktopError::Mcp(format!("{name} must be a non-negative integer"))),
    }
}

fn optional_nullable_string(
    arguments: &Map<String, Value>,
    name: &str,
    max: usize,
) -> Result<Option<String>> {
    match arguments.get(name) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.len() <= max => Ok(Some(value.clone())),
        _ => Err(DesktopError::Mcp(format!(
            "{name} must be null or contain at most {max} characters"
        ))),
    }
}

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .with_current_span(false)
        .try_init();
    tauri::Builder::default()
        .setup(|app| {
            let paths = AppPaths::new(app.path().app_data_dir()?, app.path().app_config_dir()?);
            let config = config::load_or_create(&paths)?;
            #[cfg(debug_assertions)]
            let config = {
                let cloud_override = option_env!("POKEDEX_DEV_CLOUD_BASE_URL")
                    .map(str::to_string)
                    .or_else(|| std::env::var("POKEDEX_DEV_CLOUD_BASE_URL").ok());
                config::with_dev_cloud_override(config, cloud_override.as_deref())?
            };
            let mcp_token = secrets::load_or_create_mcp_token(&paths.mcp_token_file)?;
            let services = Arc::new(DesktopServices::new(
                paths,
                config.clone(),
                Arc::new(KeychainTokenStore::default()),
            )?);
            let backend: Arc<dyn McpBackend> = services.clone();
            let status = Arc::new(RwLock::new(mcp::unavailable_status(
                config.mcp_port,
                mcp_token.clone(),
                "starting".to_string(),
            )));
            let mcp_generation = Arc::new(AtomicU64::new(0));
            let task = match tauri::async_runtime::block_on(mcp::start(
                config.mcp_port,
                mcp_token.clone(),
                backend,
                status.clone(),
                1,
                mcp_generation.clone(),
            )) {
                Ok((task, running_status)) => {
                    mcp_generation.store(1, Ordering::Release);
                    *tauri::async_runtime::block_on(status.write()) = running_status;
                    Some(task)
                }
                Err(error) => {
                    *tauri::async_runtime::block_on(status.write()) = mcp::unavailable_status(
                        config.mcp_port,
                        mcp_token.clone(),
                        error.to_string(),
                    );
                    None
                }
            };
            app.manage(TauriState {
                services,
                mcp_status: status,
                mcp_task: Mutex::new(task),
                mcp_generation,
                mcp_token,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            save_settings,
            redeem_pairing_code,
            disconnect_cloud,
            save_capture,
            pending_scan_image,
            pending_scan_preview_path,
            delete_pending_scan,
            open_pairing_page,
            synchronize_art,
            cancel_art_sync,
            upload_art_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pokédex Scanner");
}

#[cfg(test)]
mod tests;
