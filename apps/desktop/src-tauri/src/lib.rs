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
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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

struct DesktopServices {
    paths: AppPaths,
    config: RwLock<AppConfig>,
    inbox: PendingInbox,
    token_store: Arc<dyn DesktopTokenStore>,
    cloud: CloudClient,
    settings_lock: Mutex<()>,
    sync_lock: Mutex<()>,
    scan_lock: Mutex<()>,
    sync_cancel: Arc<AtomicBool>,
}

struct TauriState {
    services: Arc<DesktopServices>,
    mcp_status: Arc<RwLock<McpStatus>>,
    mcp_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
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
            sync_lock: Mutex::new(()),
            scan_lock: Mutex::new(()),
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
    let previous_status = state.mcp_status.read().await.clone();
    let replacement = if previous.mcp_port != config.mcp_port {
        let backend: Arc<dyn McpBackend> = state.services.clone();
        match mcp::start(
            config.mcp_port,
            state.mcp_token.clone(),
            backend,
            state.mcp_status.clone(),
        )
        .await
        {
            Ok(task) => Some(task),
            Err(error) => return Err(display_error(error)),
        }
    } else {
        None
    };
    if let Err(error) = config::save(&state.services.paths.config_file, &config) {
        if let Some(task) = replacement {
            task.abort();
            *state.mcp_status.write().await = previous_status;
        }
        return Err(display_error(error));
    }
    *state.services.config.write().await = config.clone();
    if let Some(replacement) = replacement {
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
    let config = state.services.config.read().await.clone();
    let result = state
        .services
        .cloud
        .redeem_pairing_code(&config.cloud_base_url, &code, &config.device_label)
        .await
        .map_err(display_error)?;
    let missing = REQUIRED_SCOPES
        .iter()
        .filter(|scope| !result.scopes.iter().any(|granted| granted == **scope))
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!(
            "Pairing token is missing required scopes: {}",
            missing.join(", ")
        ));
    }
    state
        .services
        .token_store
        .set(&config.cloud_base_url, &result.token)
        .map_err(display_error)?;
    Ok(result.scopes)
}

#[tauri::command]
async fn disconnect_cloud(state: tauri::State<'_, TauriState>) -> std::result::Result<(), String> {
    let origin = state.services.config.read().await.cloud_base_url.clone();
    state
        .services
        .token_store
        .delete(&origin)
        .map_err(display_error)
}

#[tauri::command]
fn save_capture(
    state: tauri::State<'_, TauriState>,
    bytes: Vec<u8>,
    mime_type: String,
    source: CaptureSource,
) -> std::result::Result<PendingScan, String> {
    state
        .services
        .inbox
        .save(&bytes, &mime_type, source)
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
fn delete_pending_scan(
    state: tauri::State<'_, TauriState>,
    scan_id: Uuid,
) -> std::result::Result<(), String> {
    state.services.inbox.delete(scan_id).map_err(display_error)
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
                Ok(ToolPayload::Structured(
                    self.handle_cloud(&base, &token, result)?,
                ))
            }
            ToolName::CardGet => {
                let card_id = required_string(&arguments, "cardId", 128)?;
                let (base, token) = self.cloud_context().await?;
                let result = self.cloud.card(&base, &token, card_id).await;
                Ok(ToolPayload::Structured(
                    self.handle_cloud(&base, &token, result)?,
                ))
            }
            ToolName::BindersList => {
                let (base, token) = self.cloud_context().await?;
                let result = self.cloud.list_binders(&base, &token).await;
                Ok(ToolPayload::Structured(
                    self.handle_cloud(&base, &token, result)?,
                ))
            }
            ToolName::BinderGet => {
                let version_id = required_string(&arguments, "versionId", 128)?;
                let (base, token) = self.cloud_context().await?;
                let result = self.cloud.binder(&base, &token, version_id).await;
                Ok(ToolPayload::Structured(
                    self.handle_cloud(&base, &token, result)?,
                ))
            }
            ToolName::BinderSuggest => {
                let version_id = required_string(&arguments, "versionId", 128)?;
                let (base, token) = self.cloud_context().await?;
                let result = self
                    .cloud
                    .binder_suggestions(&base, &token, version_id)
                    .await;
                Ok(ToolPayload::Structured(
                    self.handle_cloud(&base, &token, result)?,
                ))
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
                Ok(ToolPayload::Structured(
                    self.handle_cloud(&base, &token, result)?,
                ))
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
                Ok(ToolPayload::Structured(
                    self.handle_cloud(&base, &token, result)?,
                ))
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
                Ok(ToolPayload::Structured(
                    self.handle_cloud(&base, &token, result)?,
                ))
            }
        }
    }
}

impl DesktopServices {
    async fn confirm_scan(&self, arguments: &Map<String, Value>) -> Result<ToolPayload> {
        let _guard = self.scan_lock.lock().await;
        if arguments.get("confirmed").and_then(Value::as_bool) != Some(true) {
            return Err(DesktopError::Mcp(
                "confirmed must be true before the collection can change".to_string(),
            ));
        }
        let scan_id = required_uuid(arguments, "scanId")?;
        let card_id = required_string(arguments, "cardId", 128)?;
        let claimed = self.inbox.claim(scan_id, card_id)?;
        if claimed.state == ScanState::Completed {
            let completed = claimed.completed_result.ok_or_else(|| {
                DesktopError::Mcp("completed scan is missing its stored result".to_string())
            })?;
            self.inbox.finish_completed(scan_id)?;
            return Ok(ToolPayload::Structured(completed));
        }
        self.inbox.read_image(scan_id)?;
        let (base, token) = self.cloud_context().await?;
        let mutation = self
            .cloud
            .increment_collection(&base, &token, card_id, 1, claimed.mutation_id)
            .await;
        let mutation = self.handle_cloud(&base, &token, mutation)?;
        let result = json!({
            "confirmedCardId": card_id,
            "collection": mutation,
            "deletedScanId": scan_id
        });
        self.inbox.complete(scan_id, result.clone())?;
        self.inbox.finish_completed(scan_id)?;
        Ok(ToolPayload::Structured(result))
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

fn object(value: Value) -> Result<Map<String, Value>> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| DesktopError::Mcp("arguments must be an object".to_string()))
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
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = AppPaths::new(app.path().app_data_dir()?, app.path().app_config_dir()?);
            let config = config::load_or_create(&paths)?;
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
            let task = match tauri::async_runtime::block_on(mcp::start(
                config.mcp_port,
                mcp_token.clone(),
                backend,
                status.clone(),
            )) {
                Ok(task) => Some(task),
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
            delete_pending_scan,
            synchronize_art,
            cancel_art_sync,
            upload_art_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pokédex Scanner");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbox::CaptureSource;
    use axum::extract::{Path as AxumPath, State};
    use axum::http::Method;
    use axum::response::{IntoResponse, Response};
    use axum::routing::{get, patch, post, put};
    use axum::{Json, Router};
    use std::sync::Mutex;
    use tempfile::tempdir;

    struct MemoryTokenStore(Mutex<Option<String>>);

    impl DesktopTokenStore for MemoryTokenStore {
        fn get(&self, _origin: &str) -> Result<Option<String>> {
            Ok(self.0.lock().expect("token lock").clone())
        }

        fn set(&self, _origin: &str, token: &str) -> Result<()> {
            *self.0.lock().expect("token lock") = Some(token.to_string());
            Ok(())
        }

        fn delete(&self, _origin: &str) -> Result<()> {
            *self.0.lock().expect("token lock") = None;
            Ok(())
        }

        fn compare_delete(&self, _origin: &str, expected: &str) -> Result<bool> {
            let mut token = self.0.lock().expect("token lock");
            if token.as_deref() != Some(expected) {
                return Ok(false);
            }
            *token = None;
            Ok(true)
        }
    }

    async fn mock_card(AxumPath(card_id): AxumPath<String>) -> Json<Value> {
        Json(json!({
            "ok": true,
            "card": {
                "id": card_id,
                "name": "Test card",
                "collection": null
            }
        }))
    }

    async fn mock_collection(
        AxumPath(card_id): AxumPath<String>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        assert_eq!(body["delta"], 1);
        assert!(body["mutationId"].as_str().is_some());
        Json(json!({
            "ok": true,
            "state": {
                "cardId": card_id,
                "quantity": 1,
                "notes": null,
                "revision": 1,
                "updatedAt": "2026-08-24T00:00:00.000Z"
            },
            "replayed": false
        }))
    }

    async fn mock_collection_state(
        method: Method,
        AxumPath(card_id): AxumPath<String>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        if method == Method::PUT {
            assert_eq!(body["quantity"], 2);
            assert_eq!(body["expectedRevision"], 1);
        } else {
            assert_eq!(body["notes"], "sleeved");
            assert_eq!(body["expectedRevision"], 2);
        }
        Json(json!({
            "ok": true,
            "state": {
                "cardId": card_id,
                "quantity": 2,
                "notes": body.get("notes").cloned().unwrap_or(Value::Null),
                "revision": 3,
                "updatedAt": "2026-08-25T00:00:00Z"
            },
            "replayed": false
        }))
    }

    async fn mock_catalogue_search() -> Json<Value> {
        Json(json!({ "ok": true, "cards": [], "nextCursor": null }))
    }

    async fn mock_binders() -> Json<Value> {
        Json(json!({ "ok": true, "binders": [] }))
    }

    async fn mock_binder() -> Json<Value> {
        Json(json!({
            "ok": true,
            "binder": {
                "version": {
                    "id": "version-1",
                    "binderId": "binder-1",
                    "versionNumber": 1,
                    "status": "draft",
                    "layout": { "kind": "3x3", "rows": 3, "columns": 3 },
                    "revision": 1,
                    "pageCount": 0
                },
                "pages": [],
                "nextPage": null
            }
        }))
    }

    async fn mock_shortages() -> Json<Value> {
        Json(json!({ "ok": true, "shortages": [], "nextOffset": null }))
    }

    async fn mock_binder_mutation(Json(body): Json<Value>) -> Json<Value> {
        Json(json!({ "ok": true, "received": body }))
    }

    async fn mock_cloud() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("cloud listener");
        let address = listener.local_addr().expect("cloud address");
        let router = Router::new()
            .route("/api/desktop/catalogue/{card_id}", get(mock_card))
            .route(
                "/api/desktop/collection/{card_id}/increment",
                post(mock_collection),
            );
        tokio::spawn(async move {
            axum::serve(listener, router).await.expect("mock cloud");
        });
        format!("http://{address}")
    }

    async fn mock_backend_cloud() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("cloud listener");
        let address = listener.local_addr().expect("cloud address");
        let router = Router::new()
            .route("/api/desktop/catalogue/search", get(mock_catalogue_search))
            .route("/api/desktop/catalogue/{card_id}", get(mock_card))
            .route(
                "/api/desktop/binders",
                get(mock_binders).post(mock_binder_mutation),
            )
            .route(
                "/api/desktop/binders/versions/{version_id}",
                get(mock_binder),
            )
            .route(
                "/api/desktop/binders/versions/{version_id}/shortages",
                get(mock_shortages),
            )
            .route(
                "/api/desktop/binders/versions/{version_id}/slot",
                put(mock_binder_mutation),
            )
            .route(
                "/api/desktop/binders/versions/{version_id}/swap",
                post(mock_binder_mutation),
            )
            .route(
                "/api/desktop/collection/{card_id}",
                put(mock_collection_state),
            )
            .route(
                "/api/desktop/collection/{card_id}/notes",
                patch(mock_collection_state),
            )
            .route(
                "/api/desktop/collection/{card_id}/increment",
                post(mock_collection),
            );
        tokio::spawn(async move {
            axum::serve(listener, router).await.expect("mock cloud");
        });
        format!("http://{address}")
    }

    #[derive(Clone, Default)]
    struct AmbiguousMutationState(Arc<Mutex<Vec<String>>>);

    async fn ambiguous_collection(
        State(state): State<AmbiguousMutationState>,
        AxumPath(card_id): AxumPath<String>,
        Json(body): Json<Value>,
    ) -> Response {
        let mutation_id = body["mutationId"]
            .as_str()
            .expect("mutation ID")
            .to_string();
        let request_number = {
            let mut requests = state.0.lock().expect("mutation requests");
            requests.push(mutation_id);
            requests.len()
        };
        if request_number == 1 {
            return (axum::http::StatusCode::OK, "not-json").into_response();
        }
        Json(json!({
            "ok": true,
            "state": {
                "cardId": card_id,
                "quantity": 1,
                "notes": null,
                "revision": 1,
                "updatedAt": "2026-08-25T00:00:00Z"
            },
            "replayed": true
        }))
        .into_response()
    }

    async fn ambiguous_cloud() -> (String, AmbiguousMutationState) {
        let state = AmbiguousMutationState::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("cloud listener");
        let address = listener.local_addr().expect("cloud address");
        let router = Router::new()
            .route(
                "/api/desktop/collection/{card_id}/increment",
                post(ambiguous_collection),
            )
            .with_state(state.clone());
        tokio::spawn(async move {
            axum::serve(listener, router).await.expect("mock cloud");
        });
        (format!("http://{address}"), state)
    }

    #[tokio::test]
    async fn scan_confirmation_is_required_before_any_mutation_or_deletion() {
        let root = tempdir().expect("temp dir");
        let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
        let mut config = AppConfig::defaults(&paths);
        config.cloud_base_url = "http://127.0.0.1:9".to_string();
        let services = DesktopServices::new(
            paths,
            config,
            Arc::new(MemoryTokenStore(Mutex::new(Some("token".to_string())))),
        )
        .expect("services");
        let scan = services
            .inbox
            .save(
                b"RIFF\x04\x00\x00\x00WEBPdata",
                "image/webp",
                CaptureSource::File,
            )
            .expect("scan");

        let error = services
            .call_tool(
                ToolName::ConfirmScan,
                json!({ "scanId": scan.id, "cardId": "card-1", "confirmed": false }),
            )
            .await
            .expect_err("confirmation required");

        assert!(error.to_string().contains("confirmed must be true"));
        assert_eq!(services.inbox.list().expect("pending scans").len(), 1);
    }

    #[tokio::test]
    async fn confirmed_scan_increments_collection_then_deletes_the_capture() {
        let root = tempdir().expect("temp dir");
        let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
        let mut config = AppConfig::defaults(&paths);
        config.cloud_base_url = mock_cloud().await;
        let services = DesktopServices::new(
            paths,
            config,
            Arc::new(MemoryTokenStore(Mutex::new(Some("token".to_string())))),
        )
        .expect("services");
        let scan = services
            .inbox
            .save(
                b"RIFF\x04\x00\x00\x00WEBPdata",
                "image/webp",
                CaptureSource::Camera,
            )
            .expect("scan");

        let result = services
            .call_tool(
                ToolName::ConfirmScan,
                json!({ "scanId": scan.id, "cardId": "card-1", "confirmed": true }),
            )
            .await
            .expect("confirmed scan");

        assert!(matches!(result, ToolPayload::Structured(_)));
        assert!(services.inbox.list().expect("pending scans").is_empty());
    }

    #[tokio::test]
    async fn ambiguous_confirmation_reuses_mutation_and_retries_local_deletion() {
        let root = tempdir().expect("temp dir");
        let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
        let mut config = AppConfig::defaults(&paths);
        let (cloud, requests) = ambiguous_cloud().await;
        config.cloud_base_url = cloud;
        let services = DesktopServices::new(
            paths,
            config,
            Arc::new(MemoryTokenStore(Mutex::new(Some("token".to_string())))),
        )
        .expect("services");
        let scan = services
            .inbox
            .save(
                b"RIFF\x04\x00\x00\x00WEBPdata",
                "image/webp",
                CaptureSource::Camera,
            )
            .expect("scan");
        let arguments = json!({ "scanId": scan.id, "cardId": "card-1", "confirmed": true });

        services
            .call_tool(ToolName::ConfirmScan, arguments.clone())
            .await
            .expect_err("ambiguous first response");
        assert_eq!(
            services.inbox.list().expect("claimed scan")[0].state,
            ScanState::Claimed
        );

        let result = services
            .call_tool(ToolName::ConfirmScan, arguments)
            .await
            .expect("idempotent retry");
        assert!(matches!(result, ToolPayload::Structured(_)));
        assert!(services.inbox.list().expect("pending scans").is_empty());
        let mutation_ids = requests.0.lock().expect("mutation requests");
        assert_eq!(mutation_ids.len(), 2);
        assert_eq!(mutation_ids[0], mutation_ids[1]);
    }

    #[test]
    fn real_desktop_backend_lists_pending_scans() {
        let root = tempdir().expect("temp dir");
        let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
        let services = DesktopServices::new(
            paths.clone(),
            AppConfig::defaults(&paths),
            Arc::new(MemoryTokenStore(Mutex::new(None))),
        )
        .expect("services");
        services
            .inbox
            .save(
                b"RIFF\x04\x00\x00\x00WEBPdata",
                "image/webp",
                CaptureSource::File,
            )
            .expect("scan");
        let result = tauri::async_runtime::block_on(
            services.call_tool(ToolName::PendingScansList, json!({})),
        )
        .expect("pending scan tool");
        let ToolPayload::Structured(value) = result else {
            panic!("expected structured scan list");
        };
        assert_eq!(value["scans"].as_array().map(Vec::len), Some(1));
    }

    #[tokio::test]
    async fn every_registered_tool_dispatches_through_the_real_desktop_backend() {
        let root = tempdir().expect("temp dir");
        let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
        let mut config = AppConfig::defaults(&paths);
        config.cloud_base_url = mock_backend_cloud().await;
        let services = DesktopServices::new(
            paths,
            config,
            Arc::new(MemoryTokenStore(Mutex::new(Some("token".to_string())))),
        )
        .expect("services");
        let image_scan = services
            .inbox
            .save(
                b"RIFF\x04\x00\x00\x00WEBPdata",
                "image/webp",
                CaptureSource::File,
            )
            .expect("image scan");
        let confirm_scan = services
            .inbox
            .save(
                b"RIFF\x04\x00\x00\x00WEBPdata",
                "image/webp",
                CaptureSource::Camera,
            )
            .expect("confirmation scan");
        let cases = [
            (
                ToolName::CatalogueSearch,
                json!({ "query": "Pikachu", "limit": 5 }),
            ),
            (ToolName::CardGet, json!({ "cardId": "card-1" })),
            (ToolName::BindersList, json!({})),
            (ToolName::BinderGet, json!({ "versionId": "version-1" })),
            (ToolName::BinderSuggest, json!({ "versionId": "version-1" })),
            (ToolName::PendingScansList, json!({})),
            (
                ToolName::PendingScanImage,
                json!({ "scanId": image_scan.id }),
            ),
            (
                ToolName::ConfirmScan,
                json!({ "scanId": confirm_scan.id, "cardId": "card-1", "confirmed": true }),
            ),
            (
                ToolName::CollectionSet,
                json!({ "cardId": "card-1", "quantity": 2, "notes": null, "expectedRevision": 1 }),
            ),
            (
                ToolName::CollectionNotes,
                json!({ "cardId": "card-1", "notes": "sleeved", "expectedRevision": 2 }),
            ),
            (
                ToolName::BinderCreateDraft,
                json!({ "name": "Trade binder", "layout": { "kind": "3x3", "rows": 3, "columns": 3 } }),
            ),
            (
                ToolName::BinderSlotSet,
                json!({ "versionId": "version-1", "expectedRevision": 1, "page": 0, "row": 0, "column": 0, "cardId": "card-1" }),
            ),
            (
                ToolName::BinderSlotSwap,
                json!({
                    "versionId": "version-1",
                    "expectedRevision": 1,
                    "source": { "page": 0, "row": 0, "column": 0 },
                    "target": { "page": 0, "row": 0, "column": 1 }
                }),
            ),
        ];

        assert_eq!(cases.len(), ToolName::ALL.len());
        for (tool, arguments) in cases {
            services
                .call_tool(tool, arguments)
                .await
                .unwrap_or_else(|error| panic!("{} failed: {error}", tool.as_str()));
        }

        let validation = services
            .call_tool(ToolName::CatalogueSearch, json!({}))
            .await
            .expect_err("missing query must fail");
        assert!(validation.to_string().contains("query must contain"));
    }

    #[test]
    fn cloud_token_is_not_part_of_serialized_configuration() {
        let root = tempdir().expect("temp dir");
        let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
        let serialized = serde_json::to_string(&AppConfig::defaults(&paths)).expect("config JSON");
        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn rust_required_scopes_match_the_shared_typescript_contract() {
        let shared = include_str!("../../../../packages/shared/src/index.ts");
        let declaration = shared
            .split_once("export const DESKTOP_SCOPES = [")
            .and_then(|(_, remainder)| remainder.split_once("] as const;"))
            .map(|(declaration, _)| declaration)
            .expect("shared desktop scope declaration");
        let shared_scopes = declaration
            .lines()
            .filter_map(|line| {
                line.trim()
                    .strip_prefix('\'')
                    .and_then(|line| line.split_once('\''))
            })
            .map(|(scope, _)| scope)
            .collect::<std::collections::BTreeSet<_>>();
        let rust_scopes = REQUIRED_SCOPES
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();

        assert_eq!(rust_scopes, shared_scopes);
    }

    #[tokio::test]
    async fn revoked_cloud_token_is_removed_from_the_store() {
        let root = tempdir().expect("temp dir");
        let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
        let store = Arc::new(MemoryTokenStore(Mutex::new(Some("revoked".to_string()))));
        let services =
            DesktopServices::new(paths.clone(), AppConfig::defaults(&paths), store.clone())
                .expect("services");

        let error = services
            .handle_cloud::<()>(
                "https://pokedex.example",
                "revoked",
                Err(DesktopError::Cloud {
                    status: 401,
                    code: "desktop_token_invalid".to_string(),
                }),
            )
            .expect_err("revoked token error");

        assert!(error.to_string().contains("desktop_token_invalid"));
        assert!(store
            .get("https://pokedex.example")
            .expect("stored token")
            .is_none());
    }

    #[test]
    fn compare_delete_cannot_remove_a_concurrently_replaced_token() {
        use std::sync::Barrier;

        for _ in 0..200 {
            let store = Arc::new(MemoryTokenStore(Mutex::new(Some("old".to_string()))));
            let barrier = Arc::new(Barrier::new(3));
            let deleting_store = Arc::clone(&store);
            let deleting_barrier = Arc::clone(&barrier);
            let deleting = std::thread::spawn(move || {
                deleting_barrier.wait();
                deleting_store
                    .compare_delete("https://pokedex.example", "old")
                    .expect("compare delete");
            });
            let setting_store = Arc::clone(&store);
            let setting_barrier = Arc::clone(&barrier);
            let setting = std::thread::spawn(move || {
                setting_barrier.wait();
                setting_store
                    .set("https://pokedex.example", "new")
                    .expect("replacement token");
            });
            barrier.wait();
            deleting.join().expect("delete thread");
            setting.join().expect("set thread");
            assert_eq!(
                store.get("https://pokedex.example").expect("stored token"),
                Some("new".to_string())
            );
        }
    }
}
