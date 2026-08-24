mod cloud;
mod config;
mod error;
mod inbox;
mod mcp;
mod secrets;
mod sync;

use crate::cloud::{ArtVariant, CloudClient};
use crate::config::{AppConfig, AppPaths};
use crate::error::{DesktopError, Result};
use crate::inbox::{CaptureSource, PendingInbox, PendingScan, PendingScanImage};
use crate::mcp::{McpBackend, McpStatus, ToolPayload};
use crate::secrets::{DesktopTokenStore, KeychainTokenStore};
use crate::sync::{ArtSyncEngine, CloudArtRemote, SyncReport, TcgdexArtSource, UploadOutcome};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::RwLock;
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
}

struct TauriState {
    services: Arc<DesktopServices>,
    mcp_status: RwLock<McpStatus>,
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
        })
    }

    fn cloud_token(&self) -> Result<String> {
        self.token_store.get()?.ok_or(DesktopError::NotPaired)
    }

    fn handle_cloud<T>(&self, result: Result<T>) -> Result<T> {
        if matches!(result, Err(DesktopError::Cloud { status: 401, .. })) {
            self.token_store.delete()?;
        }
        result
    }

    async fn cloud_context(&self) -> Result<(String, String)> {
        let config = self.config.read().await;
        Ok((config.cloud_base_url.clone(), self.cloud_token()?))
    }
}

#[tauri::command]
async fn desktop_status(
    state: tauri::State<'_, TauriState>,
) -> std::result::Result<DesktopStatus, String> {
    let paired = state
        .services
        .token_store
        .get()
        .map_err(display_error)?
        .is_some();
    Ok(DesktopStatus {
        config: state.services.config.read().await.clone(),
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
    config.validate().map_err(display_error)?;
    sync::validate_library_path(&config.image_library_path).map_err(display_error)?;
    config::save(&state.services.paths.config_file, &config).map_err(display_error)?;
    *state.services.config.write().await = config.clone();
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
        .set(&result.token)
        .map_err(display_error)?;
    Ok(result.scopes)
}

#[tauri::command]
fn disconnect_cloud(state: tauri::State<'_, TauriState>) -> std::result::Result<(), String> {
    state.services.token_store.delete().map_err(display_error)
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
    .synchronize()
    .await
    .map_err(display_error)
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
    async fn call_tool(&self, name: &str, arguments: Value) -> Result<ToolPayload> {
        let arguments = object(arguments)?;
        match name {
            "pokedex_catalogue_search" => {
                let query = required_string(&arguments, "query", 200)?;
                let limit = optional_u64(&arguments, "limit")?
                    .unwrap_or(20)
                    .clamp(1, 100) as u16;
                let (base, token) = self.cloud_context().await?;
                let result = self
                    .cloud
                    .catalogue_search(&base, &token, query, limit)
                    .await;
                Ok(ToolPayload::Structured(self.handle_cloud(result)?))
            }
            "pokedex_card_get" => {
                let card_id = required_string(&arguments, "cardId", 128)?;
                let (base, token) = self.cloud_context().await?;
                let result = self.cloud.card(&base, &token, card_id).await;
                Ok(ToolPayload::Structured(self.handle_cloud(result)?))
            }
            "pokedex_binders_list" => {
                let (base, token) = self.cloud_context().await?;
                let result = self.cloud.list_binders(&base, &token).await;
                Ok(ToolPayload::Structured(self.handle_cloud(result)?))
            }
            "pokedex_binder_get" => {
                let version_id = required_string(&arguments, "versionId", 128)?;
                let (base, token) = self.cloud_context().await?;
                let result = self.cloud.binder(&base, &token, version_id).await;
                Ok(ToolPayload::Structured(self.handle_cloud(result)?))
            }
            "pokedex_binder_suggest" => {
                let version_id = required_string(&arguments, "versionId", 128)?;
                let (base, token) = self.cloud_context().await?;
                let result = self
                    .cloud
                    .binder_suggestions(&base, &token, version_id)
                    .await;
                Ok(ToolPayload::Structured(self.handle_cloud(result)?))
            }
            "pokedex_pending_scans_list" => Ok(ToolPayload::Structured(json!({
                "scans": self.inbox.list()?
            }))),
            "pokedex_pending_scan_image" => {
                let scan_id = required_uuid(&arguments, "scanId")?;
                let image = self.inbox.read_image(scan_id)?;
                Ok(ToolPayload::Image {
                    mime_type: image.mime_type,
                    base64_data: image.data,
                    metadata: json!({ "scanId": image.id }),
                })
            }
            "pokedex_confirm_scan" => self.confirm_scan(&arguments).await,
            "pokedex_collection_set" => self.set_collection_tool(&arguments).await,
            "pokedex_collection_notes" => self.set_notes_tool(&arguments).await,
            "pokedex_binder_create_draft" => {
                let name = required_string(&arguments, "name", 120)?;
                let layout = arguments
                    .get("layout")
                    .cloned()
                    .ok_or_else(|| DesktopError::Mcp("layout is required".to_string()))?;
                let (base, token) = self.cloud_context().await?;
                let result = self.cloud.create_binder(&base, &token, name, layout).await;
                Ok(ToolPayload::Structured(self.handle_cloud(result)?))
            }
            "pokedex_binder_slot_set" => {
                let version_id = required_string(&arguments, "versionId", 128)?;
                let slot = json!({
                    "page": required_u64(&arguments, "page")?,
                    "row": required_u64(&arguments, "row")?,
                    "column": required_u64(&arguments, "column")?,
                    "cardId": optional_nullable_string(&arguments, "cardId", 128)?,
                });
                let (base, token) = self.cloud_context().await?;
                let result = self
                    .cloud
                    .set_binder_slot(&base, &token, version_id, slot)
                    .await;
                Ok(ToolPayload::Structured(self.handle_cloud(result)?))
            }
            _ => Err(DesktopError::Mcp(format!("unknown tool: {name}"))),
        }
    }
}

impl DesktopServices {
    async fn confirm_scan(&self, arguments: &Map<String, Value>) -> Result<ToolPayload> {
        if arguments.get("confirmed").and_then(Value::as_bool) != Some(true) {
            return Err(DesktopError::Mcp(
                "confirmed must be true before the collection can change".to_string(),
            ));
        }
        let scan_id = required_uuid(arguments, "scanId")?;
        let card_id = required_string(arguments, "cardId", 128)?;
        self.inbox.read_image(scan_id)?;
        let (base, token) = self.cloud_context().await?;
        let card_response = self.handle_cloud(self.cloud.card(&base, &token, card_id).await)?;
        let card = card_response
            .get("card")
            .and_then(Value::as_object)
            .ok_or_else(|| DesktopError::InvalidCloudResponse("card is missing".to_string()))?;
        if card.get("id").and_then(Value::as_str) != Some(card_id) {
            return Err(DesktopError::InvalidCloudResponse(
                "confirmed card identifier did not match the cloud response".to_string(),
            ));
        }
        let collection = card.get("collection").and_then(Value::as_object);
        let quantity = collection
            .and_then(|value| value.get("quantity"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if quantity >= 9999 {
            return Err(DesktopError::Mcp(
                "quantity is already at the maximum of 9999".to_string(),
            ));
        }
        let notes = collection
            .and_then(|value| value.get("notes"))
            .and_then(Value::as_str);
        let mutation = self
            .cloud
            .set_collection(
                &base,
                &token,
                card_id,
                quantity as u32 + 1,
                notes,
                Uuid::new_v4(),
            )
            .await;
        let mutation = self.handle_cloud(mutation)?;
        self.inbox.delete(scan_id)?;
        Ok(ToolPayload::Structured(json!({
            "confirmedCard": card_response["card"],
            "collection": mutation,
            "deletedScanId": scan_id
        })))
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
        let (base, token) = self.cloud_context().await?;
        let result = self
            .cloud
            .set_collection(
                &base,
                &token,
                card_id,
                quantity as u32,
                notes.as_deref(),
                Uuid::new_v4(),
            )
            .await;
        Ok(ToolPayload::Structured(self.handle_cloud(result)?))
    }

    async fn set_notes_tool(&self, arguments: &Map<String, Value>) -> Result<ToolPayload> {
        let card_id = required_string(arguments, "cardId", 128)?;
        let notes = optional_nullable_string(arguments, "notes", 2000)?;
        let (base, token) = self.cloud_context().await?;
        let card = self.handle_cloud(self.cloud.card(&base, &token, card_id).await)?;
        let quantity = card
            .get("card")
            .and_then(|value| value.get("collection"))
            .and_then(|value| value.get("quantity"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let result = self
            .cloud
            .set_collection(
                &base,
                &token,
                card_id,
                quantity as u32,
                notes.as_deref(),
                Uuid::new_v4(),
            )
            .await;
        Ok(ToolPayload::Structured(self.handle_cloud(result)?))
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = AppPaths::new(app.path().app_data_dir()?, app.path().app_config_dir()?);
            let config = config::load_or_create(&paths)?;
            let mcp_token = secrets::load_or_create_mcp_token(&paths.mcp_token_file)?;
            let services = Arc::new(DesktopServices::new(
                paths,
                config.clone(),
                Arc::new(KeychainTokenStore),
            )?);
            let backend: Arc<dyn McpBackend> = services.clone();
            let status = tauri::async_runtime::block_on(mcp::start(
                config.mcp_port,
                mcp_token.clone(),
                backend,
            ))
            .unwrap_or_else(|error| {
                mcp::unavailable_status(config.mcp_port, mcp_token, error.to_string())
            });
            app.manage(TauriState {
                services,
                mcp_status: RwLock::new(status),
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
            upload_art_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pokédex Scanner");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inbox::CaptureSource;
    use axum::extract::Path as AxumPath;
    use axum::routing::{get, put};
    use axum::{Json, Router};
    use std::sync::Mutex;
    use tempfile::tempdir;

    struct MemoryTokenStore(Mutex<Option<String>>);

    impl DesktopTokenStore for MemoryTokenStore {
        fn get(&self) -> Result<Option<String>> {
            Ok(self.0.lock().expect("token lock").clone())
        }

        fn set(&self, token: &str) -> Result<()> {
            *self.0.lock().expect("token lock") = Some(token.to_string());
            Ok(())
        }

        fn delete(&self) -> Result<()> {
            *self.0.lock().expect("token lock") = None;
            Ok(())
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

    async fn mock_collection(AxumPath(card_id): AxumPath<String>) -> Json<Value> {
        Json(json!({
            "ok": true,
            "state": {
                "cardId": card_id,
                "quantity": 1,
                "notes": null,
                "updatedAt": "2026-08-24T00:00:00.000Z"
            },
            "replayed": false
        }))
    }

    async fn mock_cloud() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("cloud listener");
        let address = listener.local_addr().expect("cloud address");
        let router = Router::new()
            .route("/api/desktop/catalogue/{card_id}", get(mock_card))
            .route("/api/desktop/collection/{card_id}", put(mock_collection));
        tokio::spawn(async move {
            axum::serve(listener, router).await.expect("mock cloud");
        });
        format!("http://{address}")
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
                "pokedex_confirm_scan",
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
                "pokedex_confirm_scan",
                json!({ "scanId": scan.id, "cardId": "card-1", "confirmed": true }),
            )
            .await
            .expect("confirmed scan");

        assert!(matches!(result, ToolPayload::Structured(_)));
        assert!(services.inbox.list().expect("pending scans").is_empty());
    }

    #[test]
    fn cloud_token_is_not_part_of_serialized_configuration() {
        let root = tempdir().expect("temp dir");
        let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
        let serialized = serde_json::to_string(&AppConfig::defaults(&paths)).expect("config JSON");
        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("secret"));
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
            .handle_cloud::<()>(Err(DesktopError::Cloud {
                status: 401,
                code: "desktop_token_invalid".to_string(),
            }))
            .expect_err("revoked token error");

        assert!(error.to_string().contains("desktop_token_invalid"));
        assert!(store.get().expect("stored token").is_none());
    }
}
