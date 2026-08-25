use super::*;
use crate::inbox::CaptureSource;
use axum::extract::{Path as AxumPath, State};
use axum::http::Method;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use std::sync::Mutex;
use std::time::Duration;
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
            "language": "en",
            "category": "pokemon",
            "setId": "set-1",
            "setName": "Test set",
            "number": "1",
            "imageLowUrl": null,
            "supertype": null,
            "subtype": null,
            "species": "Pikachu",
            "rarity": null,
            "artist": null,
            "imageHighUrl": null,
            "source": { "provider": "tcgdex", "sourceId": "source-1", "updatedAt": "2026-08-25T00:00:00Z" },
            "notes": null,
            "collection": null,
            "price": { "amountAud": null, "nativeAmount": null, "nativeCurrency": null,
              "source": null, "sourceCapturedAt": null, "fxDate": null }
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
    Json(json!({ "ok": true, "total": 0, "cards": [], "cursor": null }))
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
    let _ = body;
    Json(json!({
        "ok": true,
        "binder": {
            "version": {
                "id": "version-1", "binderId": "binder-1", "versionNumber": 1,
                "status": "draft", "layout": { "kind": "3x3", "rows": 3, "columns": 3 },
                "revision": 2, "pageCount": 1
            },
            "pages": []
        }
    }))
}

async fn mock_suggestions() -> Json<Value> {
    Json(json!({ "ok": true, "shortages": [], "nextOffset": null, "emptySlots": [] }))
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

async fn terminal_collection_failure() -> Response {
    (
        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        Json(json!({ "ok": false, "error": "card_not_confirmable" })),
    )
        .into_response()
}

async fn terminal_mutation_cloud() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("terminal cloud listener");
    let address = listener.local_addr().expect("terminal cloud address");
    let router = Router::new().route(
        "/api/desktop/collection/{card_id}/increment",
        post(terminal_collection_failure),
    );
    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("terminal mutation cloud");
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
            "/api/desktop/binders/versions/{version_id}/suggest",
            get(mock_suggestions),
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

#[derive(Clone)]
struct DelayedMutationState {
    started: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
    mutation_ids: Arc<Mutex<Vec<String>>>,
    ambiguous_first: bool,
}

async fn delayed_collection(
    State(state): State<DelayedMutationState>,
    AxumPath(card_id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Response {
    let request_number = {
        let mut mutation_ids = state.mutation_ids.lock().expect("mutation IDs");
        mutation_ids.push(
            body["mutationId"]
                .as_str()
                .expect("mutation ID")
                .to_string(),
        );
        mutation_ids.len()
    };
    if request_number == 1 {
        state.started.notify_one();
        state.release.notified().await;
        if state.ambiguous_first {
            return (axum::http::StatusCode::OK, "not-json").into_response();
        }
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
        "replayed": request_number > 1
    }))
    .into_response()
}

async fn delayed_mutation_cloud(ambiguous_first: bool) -> (String, DelayedMutationState) {
    let state = DelayedMutationState {
        started: Arc::new(tokio::sync::Notify::new()),
        release: Arc::new(tokio::sync::Notify::new()),
        mutation_ids: Arc::new(Mutex::new(Vec::new())),
        ambiguous_first,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("mutation listener");
    let address = listener.local_addr().expect("mutation address");
    let router = Router::new()
        .route(
            "/api/desktop/collection/{card_id}/increment",
            post(delayed_collection),
        )
        .with_state(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("mutation cloud");
    });
    (format!("http://{address}"), state)
}

#[derive(Clone)]
struct DelayedPairing {
    started: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

async fn delayed_pairing(State(state): State<DelayedPairing>) -> Json<Value> {
    state.started.notify_one();
    state.release.notified().await;
    Json(json!({
        "ok": true,
        "token": "paired-token",
        "scopes": REQUIRED_SCOPES
    }))
}

async fn delayed_pairing_cloud() -> (String, DelayedPairing) {
    let state = DelayedPairing {
        started: Arc::new(tokio::sync::Notify::new()),
        release: Arc::new(tokio::sync::Notify::new()),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("pairing listener");
    let address = listener.local_addr().expect("pairing address");
    let router = Router::new()
        .route("/api/desktop/pair/redeem", post(delayed_pairing))
        .with_state(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("pairing cloud");
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
            b"\xff\xd8\xffpreview",
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
async fn unpaired_confirmation_preflight_leaves_the_scan_pending() {
    let root = tempdir().expect("temp dir");
    let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
    let config = AppConfig::defaults(&paths);
    let services =
        DesktopServices::new(paths, config, Arc::new(MemoryTokenStore(Mutex::new(None))))
            .expect("services");
    let scan = services
        .inbox
        .save(
            b"RIFF\x04\x00\x00\x00WEBPdata",
            b"\xff\xd8\xffpreview",
            "image/webp",
            CaptureSource::File,
        )
        .expect("scan");

    let error = services
        .call_tool(
            ToolName::ConfirmScan,
            json!({ "scanId": scan.id, "cardId": "card-1", "confirmed": true }),
        )
        .await
        .expect_err("unpaired preflight");

    assert!(matches!(error, DesktopError::NotPaired));
    let retained = services.inbox.list().expect("retained scan");
    assert_eq!(retained[0].state, ScanState::Pending);
    assert_eq!(retained[0].confirmed_card_id, None);
    assert_eq!(retained[0].mutation_id, scan.mutation_id);
}

#[tokio::test]
async fn missing_image_preflight_leaves_the_scan_pending() {
    let root = tempdir().expect("temp dir");
    let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
    let config = AppConfig::defaults(&paths);
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
            b"\xff\xd8\xffpreview",
            "image/webp",
            CaptureSource::File,
        )
        .expect("scan");
    std::fs::remove_file(services.paths.inbox_dir.join(format!("{}.webp", scan.id)))
        .expect("remove capture");

    services
        .call_tool(
            ToolName::ConfirmScan,
            json!({ "scanId": scan.id, "cardId": "card-1", "confirmed": true }),
        )
        .await
        .expect_err("image preflight");

    let retained: PendingScan = serde_json::from_slice(
        &std::fs::read(services.paths.inbox_dir.join(format!("{}.json", scan.id)))
            .expect("retained metadata"),
    )
    .expect("retained scan");
    assert_eq!(retained.state, ScanState::Pending);
    assert_eq!(retained.confirmed_card_id, None);
    assert_eq!(retained.mutation_id, scan.mutation_id);
}

#[tokio::test]
async fn terminal_confirmation_response_resets_this_calls_claim_to_pending() {
    let root = tempdir().expect("temp dir");
    let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
    let mut config = AppConfig::defaults(&paths);
    config.cloud_base_url = terminal_mutation_cloud().await;
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
            b"\xff\xd8\xffpreview",
            "image/webp",
            CaptureSource::Camera,
        )
        .expect("scan");

    let error = services
        .call_tool(
            ToolName::ConfirmScan,
            json!({ "scanId": scan.id, "cardId": "card-1", "confirmed": true }),
        )
        .await
        .expect_err("terminal response");

    assert!(matches!(error, DesktopError::Cloud { status: 422, .. }));
    let retained = services.inbox.list().expect("retained scan");
    assert_eq!(retained[0].state, ScanState::Pending);
    assert_eq!(retained[0].confirmed_card_id, None);
    assert_eq!(retained[0].mutation_id, scan.mutation_id);
}

#[tokio::test]
async fn terminal_confirmation_failure_classification_is_exact() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("temporary listener");
    let unavailable = listener.local_addr().expect("temporary address");
    drop(listener);
    let http = reqwest::Client::new()
        .get(format!("http://{unavailable}"))
        .send()
        .await
        .expect_err("closed listener must reject the request");
    let mut cases = [400_u16, 401, 403, 404, 409, 413, 422]
        .into_iter()
        .map(|status| {
            (
                format!("cloud-{status}"),
                DesktopError::Cloud {
                    status,
                    code: "terminal".to_string(),
                },
                true,
            )
        })
        .collect::<Vec<_>>();
    cases.extend([408_u16, 429, 500, 502, 503].into_iter().map(|status| {
        (
            format!("cloud-{status}"),
            DesktopError::Cloud {
                status,
                code: "ambiguous".to_string(),
            },
            false,
        )
    }));
    cases.push(("http".to_string(), DesktopError::Http(http), false));
    cases.push((
        "invalid-cloud-response".to_string(),
        DesktopError::InvalidCloudResponse("ambiguous".to_string()),
        false,
    ));

    for (name, error, expected) in cases {
        assert_eq!(
            is_terminal_non_commit_confirmation(&error),
            expected,
            "classification for {name}"
        );
    }
}

#[tokio::test]
async fn terminal_response_preserves_a_claim_from_an_earlier_ambiguous_attempt() {
    let root = tempdir().expect("temp dir");
    let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
    let mut config = AppConfig::defaults(&paths);
    config.cloud_base_url = terminal_mutation_cloud().await;
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
            b"\xff\xd8\xffpreview",
            "image/webp",
            CaptureSource::Camera,
        )
        .expect("scan");
    let claimed = services
        .inbox
        .claim(scan.id, "card-1")
        .expect("prior ambiguous claim");

    let error = services
        .call_tool(
            ToolName::ConfirmScan,
            json!({ "scanId": scan.id, "cardId": "card-1", "confirmed": true }),
        )
        .await
        .expect_err("terminal retry response");

    assert!(matches!(error, DesktopError::Cloud { status: 422, .. }));
    let retained = services.inbox.list().expect("retained claimed scan");
    assert_eq!(retained[0].state, ScanState::Claimed);
    assert_eq!(retained[0].confirmed_card_id.as_deref(), Some("card-1"));
    assert_eq!(retained[0].mutation_id, claimed.mutation_id);
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
            b"\xff\xd8\xffpreview",
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
            b"\xff\xd8\xffpreview",
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
fn scan_transaction_probe_child() {
    let Ok(root) = std::env::var("POKEDEX_TEST_SCAN_LOCK_ROOT") else {
        return;
    };
    let same_scan =
        Uuid::parse_str(&std::env::var("POKEDEX_TEST_LOCKED_SCAN_ID").expect("locked scan ID"))
            .expect("locked scan UUID");
    let other_scan =
        Uuid::parse_str(&std::env::var("POKEDEX_TEST_OTHER_SCAN_ID").expect("other scan ID"))
            .expect("other scan UUID");
    let result =
        PathBuf::from(std::env::var("POKEDEX_TEST_SCAN_LOCK_RESULT").expect("result marker"));
    let inbox = PendingInbox::new(PathBuf::from(root));

    let same_error = match inbox.begin_scan_transaction(same_scan) {
        Ok(_) => panic!("the in-flight scan lease must be held by the parent process"),
        Err(error) => error,
    };
    assert!(same_error
        .to_string()
        .contains("transaction is already running in another process"));
    inbox
        .claim(other_scan, "card-other")
        .expect("a different scan remains independently operable");
    std::fs::write(result, b"same=blocked;other=claimed").expect("result marker");
}

#[tokio::test]
async fn ambiguous_confirmation_serializes_delete_and_reuses_the_mutation_identity() {
    let root = tempdir().expect("temp dir");
    let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
    let (cloud, mutation) = delayed_mutation_cloud(true).await;
    let mut config = AppConfig::defaults(&paths);
    config.cloud_base_url = cloud;
    let services = Arc::new(
        DesktopServices::new(
            paths,
            config,
            Arc::new(MemoryTokenStore(Mutex::new(Some("token".to_string())))),
        )
        .expect("services"),
    );
    let scan = services
        .inbox
        .save(
            b"RIFF\x04\x00\x00\x00WEBPdata",
            b"\xff\xd8\xffpreview",
            "image/webp",
            CaptureSource::Camera,
        )
        .expect("scan");
    let other_scan = services
        .inbox
        .save(
            b"RIFF\x04\x00\x00\x00WEBPdata",
            b"\xff\xd8\xffpreview",
            "image/webp",
            CaptureSource::File,
        )
        .expect("other scan");
    let confirm_services = services.clone();
    let arguments = json!({"scanId":scan.id,"cardId":"card-1","confirmed":true});
    let confirm_arguments = arguments.clone();
    let confirm = tokio::spawn(async move {
        confirm_services
            .call_tool(ToolName::ConfirmScan, confirm_arguments)
            .await
    });
    mutation.started.notified().await;

    let child_result = root.path().join("scan-lock-result");
    let child = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .arg("--exact")
        .arg("tests::scan_transaction_probe_child")
        .arg("--nocapture")
        .env("POKEDEX_TEST_SCAN_LOCK_ROOT", &services.paths.inbox_dir)
        .env("POKEDEX_TEST_LOCKED_SCAN_ID", scan.id.to_string())
        .env("POKEDEX_TEST_OTHER_SCAN_ID", other_scan.id.to_string())
        .env("POKEDEX_TEST_SCAN_LOCK_RESULT", &child_result)
        .output()
        .expect("scan-lock probe process");
    assert!(
        child.status.success(),
        "scan-lock probe failed: {}",
        String::from_utf8_lossy(&child.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(child_result).expect("scan-lock result"),
        "same=blocked;other=claimed"
    );

    let contended = Arc::new(tokio::sync::Notify::new());
    *services
        .scan_lock_contended
        .lock()
        .expect("contention hook") = Some(contended.clone());
    let delete_services = services.clone();
    let delete = tokio::spawn(async move { delete_services.delete_scan(scan.id).await });
    contended.notified().await;
    assert!(!delete.is_finished(), "delete reached scan-lock contention");
    mutation.release.notify_one();

    confirm
        .await
        .expect("confirm task")
        .expect_err("the first response is ambiguous");
    let delete_error = delete
        .await
        .expect("delete task")
        .expect_err("claimed scans cannot be user-deleted");
    assert!(delete_error
        .to_string()
        .contains("cannot delete a claimed or completed scan"));

    let retry = services
        .call_tool(ToolName::ConfirmScan, arguments)
        .await
        .expect("idempotent confirmation retry");
    assert!(matches!(retry, ToolPayload::Structured(_)));
    assert!(!services
        .inbox
        .list()
        .expect("remaining scans")
        .iter()
        .any(|pending| pending.id == scan.id));
    assert_eq!(
        mutation
            .mutation_ids
            .lock()
            .expect("mutation IDs")
            .as_slice(),
        &[scan.mutation_id.to_string(), scan.mutation_id.to_string()]
    );
}

#[tokio::test]
async fn unrelated_delete_and_finalization_wait_for_the_short_destructive_phase() {
    let root = tempdir().expect("temp dir");
    let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
    let config = AppConfig::defaults(&paths);
    let services = Arc::new(
        DesktopServices::new(
            paths,
            config,
            Arc::new(MemoryTokenStore(Mutex::new(Some("token".to_string())))),
        )
        .expect("services"),
    );
    let pending = services
        .inbox
        .save(
            b"RIFF\x04\x00\x00\x00WEBPdata",
            b"\xff\xd8\xffpreview",
            "image/webp",
            CaptureSource::File,
        )
        .expect("pending scan");
    let completed = services
        .inbox
        .save(
            b"RIFF\x04\x00\x00\x00WEBPdata",
            b"\xff\xd8\xffpreview",
            "image/webp",
            CaptureSource::Camera,
        )
        .expect("completed scan");
    services
        .inbox
        .claim(completed.id, "card-2")
        .expect("claim completed fixture");
    services
        .inbox
        .complete(completed.id, json!({ "ok": true }))
        .expect("complete fixture");

    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let contended = Arc::new(tokio::sync::Notify::new());
    *services
        .delete_phase_pause
        .lock()
        .expect("delete phase pause") = Some((entered.clone(), release.clone()));
    *services
        .delete_phase_contended
        .lock()
        .expect("delete phase contention") = Some(contended.clone());

    let deleting_services = services.clone();
    let deleting = tokio::spawn(async move { deleting_services.delete_scan(pending.id).await });
    entered.notified().await;

    let finalizing_services = services.clone();
    let finalizing = tokio::spawn(async move {
        let _scan_guard = finalizing_services
            .acquire_process_scan_lock(completed.id)
            .await;
        let transaction = finalizing_services
            .inbox
            .begin_scan_transaction(completed.id)?;
        let _delete_guard = finalizing_services.acquire_delete_phase_lock().await;
        transaction.finish_completed()
    });
    contended.notified().await;
    assert!(
        !finalizing.is_finished(),
        "the second scan reached destructive-phase contention"
    );

    release.notify_one();
    deleting
        .await
        .expect("delete task")
        .expect("pending deletion");
    finalizing
        .await
        .expect("finalize task")
        .expect("completed finalization");
    assert!(services.inbox.list().expect("empty inbox").is_empty());
}

#[tokio::test]
async fn aborting_confirmation_releases_process_and_cross_process_scan_leases() {
    let root = tempdir().expect("temp dir");
    let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
    let (cloud, mutation) = delayed_mutation_cloud(false).await;
    let mut config = AppConfig::defaults(&paths);
    config.cloud_base_url = cloud;
    let services = Arc::new(
        DesktopServices::new(
            paths,
            config,
            Arc::new(MemoryTokenStore(Mutex::new(Some("token".to_string())))),
        )
        .expect("services"),
    );
    let scan = services
        .inbox
        .save(
            b"RIFF\x04\x00\x00\x00WEBPdata",
            b"\xff\xd8\xffpreview",
            "image/webp",
            CaptureSource::Camera,
        )
        .expect("scan");
    let confirm_services = services.clone();
    let confirm = tokio::spawn(async move {
        confirm_services
            .call_tool(
                ToolName::ConfirmScan,
                json!({"scanId":scan.id,"cardId":"card-1","confirmed":true}),
            )
            .await
    });
    mutation.started.notified().await;

    confirm.abort();
    assert!(confirm
        .await
        .expect_err("confirmation is cancelled")
        .is_cancelled());
    mutation.release.notify_one();

    let process_guard = tokio::time::timeout(
        Duration::from_secs(1),
        services.acquire_process_scan_lock(scan.id),
    )
    .await
    .expect("process lease releases immediately");
    let transaction = services
        .inbox
        .begin_scan_transaction(scan.id)
        .expect("cross-process lease releases immediately");
    drop(transaction);
    drop(process_guard);
}

#[tokio::test]
async fn disconnect_waits_for_inflight_pairing_and_remains_the_last_intent() {
    let root = tempdir().expect("temp dir");
    let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
    let (cloud, pairing) = delayed_pairing_cloud().await;
    let mut config = AppConfig::defaults(&paths);
    config.cloud_base_url = cloud;
    let store = Arc::new(MemoryTokenStore(Mutex::new(Some("old-token".to_string()))));
    let services =
        Arc::new(DesktopServices::new(paths, config, store.clone()).expect("desktop services"));

    let pairing_services = services.clone();
    let pair = tokio::spawn(async move { pairing_services.pair_cloud("pair-code").await });
    pairing.started.notified().await;
    let disconnect_services = services.clone();
    let disconnect = tokio::spawn(async move { disconnect_services.disconnect().await });
    tokio::task::yield_now().await;
    assert_eq!(
        store.get("unused").expect("token before release"),
        Some("old-token".to_string())
    );

    pairing.release.notify_one();
    pair.await.expect("pair task").expect("pair result");
    disconnect
        .await
        .expect("disconnect task")
        .expect("disconnect result");
    assert!(store.get("unused").expect("final token").is_none());
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
            b"\xff\xd8\xffpreview",
            "image/webp",
            CaptureSource::File,
        )
        .expect("scan");
    let result =
        tauri::async_runtime::block_on(services.call_tool(ToolName::PendingScansList, json!({})))
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
            b"\xff\xd8\xffpreview",
            "image/webp",
            CaptureSource::File,
        )
        .expect("image scan");
    let confirm_scan = services
        .inbox
        .save(
            b"RIFF\x04\x00\x00\x00WEBPdata",
            b"\xff\xd8\xffpreview",
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
    let services = DesktopServices::new(paths.clone(), AppConfig::defaults(&paths), store.clone())
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
