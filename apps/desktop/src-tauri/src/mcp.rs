use crate::error::{DesktopError, Result};
use async_trait::async_trait;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use subtle::ConstantTimeEq;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;

pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const MCP_PROTOCOL_HEADER: &str = "mcp-protocol-version";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub endpoint: String,
    pub config_snippet: String,
    pub running: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ToolPayload {
    Structured(Value),
    Image {
        mime_type: String,
        base64_data: String,
        metadata: Value,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolName {
    CatalogueSearch,
    CardGet,
    BindersList,
    BinderGet,
    BinderSuggest,
    BinderAssignmentCandidates,
    PendingScansList,
    PendingScanImage,
    ConfirmScan,
    CollectionSet,
    CollectionNotes,
    BinderCreateDraft,
    BinderSlotSet,
    BinderSlotSwap,
    BinderInsert,
    BinderRemove,
    BinderMove,
    BinderAssign,
    BinderPageBreak,
    BinderReservePage,
    BinderResize,
    BinderFullPokedex,
}

impl ToolName {
    pub const ALL: [Self; 22] = [
        Self::CatalogueSearch,
        Self::CardGet,
        Self::BindersList,
        Self::BinderGet,
        Self::BinderSuggest,
        Self::BinderAssignmentCandidates,
        Self::PendingScansList,
        Self::PendingScanImage,
        Self::ConfirmScan,
        Self::CollectionSet,
        Self::CollectionNotes,
        Self::BinderCreateDraft,
        Self::BinderSlotSet,
        Self::BinderSlotSwap,
        Self::BinderInsert,
        Self::BinderRemove,
        Self::BinderMove,
        Self::BinderAssign,
        Self::BinderPageBreak,
        Self::BinderReservePage,
        Self::BinderResize,
        Self::BinderFullPokedex,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CatalogueSearch => "pokedex_catalogue_search",
            Self::CardGet => "pokedex_card_get",
            Self::BindersList => "pokedex_binders_list",
            Self::BinderGet => "pokedex_binder_get",
            Self::BinderSuggest => "pokedex_binder_suggest",
            Self::BinderAssignmentCandidates => "pokedex_binder_assignment_candidates",
            Self::PendingScansList => "pokedex_pending_scans_list",
            Self::PendingScanImage => "pokedex_pending_scan_image",
            Self::ConfirmScan => "pokedex_confirm_scan",
            Self::CollectionSet => "pokedex_collection_set",
            Self::CollectionNotes => "pokedex_collection_notes",
            Self::BinderCreateDraft => "pokedex_binder_create_draft",
            Self::BinderSlotSet => "pokedex_binder_slot_set",
            Self::BinderSlotSwap => "pokedex_binder_slot_swap",
            Self::BinderInsert => "pokedex_binder_insert",
            Self::BinderRemove => "pokedex_binder_remove",
            Self::BinderMove => "pokedex_binder_move",
            Self::BinderAssign => "pokedex_binder_assign",
            Self::BinderPageBreak => "pokedex_binder_page_break",
            Self::BinderReservePage => "pokedex_binder_reserve_page",
            Self::BinderResize => "pokedex_binder_resize",
            Self::BinderFullPokedex => "pokedex_binder_full_pokedex",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|tool| tool.as_str() == value)
    }
}

#[async_trait]
pub trait McpBackend: Send + Sync {
    async fn call_tool(&self, name: ToolName, arguments: Value) -> Result<ToolPayload>;
}

#[derive(Clone)]
struct McpState {
    token: Arc<str>,
    backend: Arc<dyn McpBackend>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: Option<String>,
    params: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitializeParams {
    protocol_version: String,
    capabilities: Value,
    client_info: Value,
}

pub fn bind_address(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

pub async fn start(
    port: u16,
    token: String,
    backend: Arc<dyn McpBackend>,
    live_status: Arc<RwLock<McpStatus>>,
    generation: u64,
    active_generation: Arc<AtomicU64>,
) -> Result<(JoinHandle<()>, McpStatus)> {
    let listener = tokio::net::TcpListener::bind(bind_address(port)).await?;
    let address = listener.local_addr()?;
    let endpoint = format!("http://127.0.0.1:{}/mcp", address.port());
    let status = McpStatus {
        config_snippet: codex_config_snippet(&endpoint, &token),
        endpoint,
        running: true,
        error: None,
    };
    let router = router(token, backend);
    let task = tokio::spawn(async move {
        let result = axum::serve(listener, router).await;
        let error = result.err().map_or_else(
            || "MCP server stopped".to_string(),
            |error| error.to_string(),
        );
        tracing::error!(error = %error, "local MCP server stopped");
        publish_stopped_status(&live_status, &active_generation, generation, error).await;
    });
    Ok((task, status))
}

async fn publish_stopped_status(
    live_status: &RwLock<McpStatus>,
    active_generation: &AtomicU64,
    generation: u64,
    error: String,
) {
    let mut status = live_status.write().await;
    if active_generation.load(Ordering::Acquire) == generation {
        status.running = false;
        status.error = Some(error);
    }
}

pub fn unavailable_status(port: u16, token: String, error: String) -> McpStatus {
    let endpoint = format!("http://127.0.0.1:{port}/mcp");
    McpStatus {
        config_snippet: codex_config_snippet(&endpoint, &token),
        endpoint,
        running: false,
        error: Some(error),
    }
}

fn router(token: String, backend: Arc<dyn McpBackend>) -> Router {
    Router::new()
        .route("/mcp", post(handle_post).get(handle_get))
        .with_state(McpState {
            token: Arc::from(token),
            backend,
        })
}

async fn handle_get(State(state): State<McpState>, headers: HeaderMap) -> Response {
    if let Err(response) = authorize(&headers, &state.token) {
        return response.into_response();
    }
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST")],
        "This MCP server does not expose an SSE stream.",
    )
        .into_response()
}

async fn handle_post(State(state): State<McpState>, headers: HeaderMap, body: Bytes) -> Response {
    if let Err(response) = authorize(&headers, &state.token) {
        return response.into_response();
    }
    if !accepts_json(&headers) {
        return (
            StatusCode::NOT_ACCEPTABLE,
            "Accept application/json is required",
        )
            .into_response();
    }
    let request: JsonRpcRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => {
            return json_response(
                StatusCode::OK,
                rpc_error(None, -32700, format!("Invalid JSON: {error}")),
            )
        }
    };
    if request.jsonrpc.as_deref() != Some("2.0") {
        return json_response(
            StatusCode::OK,
            rpc_error(request.id, -32600, "jsonrpc must be 2.0".to_string()),
        );
    }
    if request.method.as_deref() != Some("initialize") && !valid_protocol_header(&headers) {
        return (
            StatusCode::BAD_REQUEST,
            "MCP-Protocol-Version must be 2025-06-18",
        )
            .into_response();
    }
    let Some(id) = request.id.clone() else {
        if request.method.as_deref() == Some("notifications/initialized") {
            return StatusCode::ACCEPTED.into_response();
        }
        return StatusCode::ACCEPTED.into_response();
    };
    let result = handle_request(&state, request, id).await;
    json_response(StatusCode::OK, result)
}

async fn handle_request(state: &McpState, request: JsonRpcRequest, id: Value) -> Value {
    match request.method.as_deref() {
        Some("initialize") => initialize(id, request.params),
        Some("ping") => rpc_success(id, json!({})),
        Some("tools/list") => rpc_success(id, json!({ "tools": tool_definitions() })),
        Some("tools/call") => call_tool(state, id, request.params).await,
        Some("resources/list") => rpc_success(id, json!({ "resources": [] })),
        Some("prompts/list") => rpc_success(id, json!({ "prompts": [] })),
        Some(method) => rpc_error(Some(id), -32601, format!("Unknown method: {method}")),
        None => rpc_error(Some(id), -32600, "method is required".to_string()),
    }
}

async fn call_tool(state: &McpState, id: Value, params: Option<Value>) -> Value {
    let Some(name) = params
        .as_ref()
        .and_then(|value| value.get("name"))
        .and_then(Value::as_str)
    else {
        return rpc_error(Some(id), -32602, "tools/call requires a name".to_string());
    };
    let Some(name) = ToolName::parse(name) else {
        return rpc_error(Some(id), -32601, format!("Unknown tool: {name}"));
    };
    let arguments = params
        .and_then(|value| value.get("arguments").cloned())
        .unwrap_or_else(|| json!({}));
    let operation_id = uuid::Uuid::new_v4();
    let started = Instant::now();
    tracing::debug!(
        target: "pokedex.mcp",
        event = "mcp.tool.started",
        operation_id = %operation_id,
        tool = name.as_str(),
        "MCP tool started"
    );
    let result = state.backend.call_tool(name, arguments).await;
    match &result {
        Ok(_) => tracing::debug!(
            target: "pokedex.mcp",
            event = "mcp.tool.completed",
            operation_id = %operation_id,
            tool = name.as_str(),
            duration_ms = started.elapsed().as_millis(),
            "MCP tool completed"
        ),
        Err(error) => tracing::warn!(
            target: "pokedex.mcp",
            event = "mcp.tool.failed",
            operation_id = %operation_id,
            tool = name.as_str(),
            duration_ms = started.elapsed().as_millis(),
            error_class = std::any::type_name_of_val(error),
            request_id = ?cloud_request_id(error),
            "MCP tool failed"
        ),
    }
    match result {
        Ok(ToolPayload::Structured(value)) => rpc_success(id, structured_tool_result(value)),
        Ok(ToolPayload::Image {
            mime_type,
            base64_data,
            metadata,
        }) => rpc_success(
            id,
            json!({
                "content": [
                    { "type": "image", "data": base64_data, "mimeType": mime_type },
                    { "type": "text", "text": serde_json::to_string_pretty(&metadata).unwrap_or_else(|_| "{}".to_string()) }
                ],
                "structuredContent": metadata,
                "isError": false
            }),
        ),
        Err(error) => rpc_success(id, structured_tool_error(&error)),
    }
}

enum AuthorizationFailure {
    Forbidden,
    Unauthorized,
}

impl IntoResponse for AuthorizationFailure {
    fn into_response(self) -> Response {
        match self {
            Self::Forbidden => (StatusCode::FORBIDDEN, "Loopback requests only").into_response(),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "Unauthorized").into_response(),
        }
    }
}

fn authorize(headers: &HeaderMap, expected: &str) -> std::result::Result<(), AuthorizationFailure> {
    if !valid_loopback_host(headers) || !valid_origin(headers) {
        return Err(AuthorizationFailure::Forbidden);
    }
    let supplied = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if supplied.is_some_and(|token| constant_time_equal(token, expected)) {
        Ok(())
    } else {
        Err(AuthorizationFailure::Unauthorized)
    }
}

fn accepts_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|part| part.trim() == "application/json")
        })
}

fn valid_protocol_header(headers: &HeaderMap) -> bool {
    headers
        .get(MCP_PROTOCOL_HEADER)
        .and_then(|value| value.to_str().ok())
        == Some(MCP_PROTOCOL_VERSION)
}

fn initialize(id: Value, params: Option<Value>) -> Value {
    let parsed = params
        .and_then(|value| serde_json::from_value::<InitializeParams>(value).ok())
        .filter(|params| {
            params.protocol_version == MCP_PROTOCOL_VERSION
                && params.capabilities.is_object()
                && params.client_info.is_object()
        });
    if parsed.is_none() {
        return rpc_error(
            Some(id),
            -32602,
            "initialize requires protocolVersion 2025-06-18, capabilities, and clientInfo"
                .to_string(),
        );
    }
    rpc_success(
        id,
        json!({
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": {
                "name": "pokedex-desktop",
                "title": "Pokédex Desktop",
                "version": env!("CARGO_PKG_VERSION")
            }
        }),
    )
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    left.len() == right.len() && left.as_bytes().ct_eq(right.as_bytes()).into()
}

fn valid_loopback_host(headers: &HeaderMap) -> bool {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            if value.starts_with('[') {
                value.split_once(']').map(|(host, _)| format!("{host}]"))
            } else {
                Some(value.split(':').next().unwrap_or_default().to_string())
            }
        })
        .is_some_and(|host| matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]"))
}

fn valid_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    url::Url::parse(origin)
        .ok()
        .and_then(|url| url.host_str().map(ToString::to_string))
        .is_some_and(|host| matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1"))
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE.as_str(), "application/json"),
            (MCP_PROTOCOL_HEADER, MCP_PROTOCOL_VERSION),
        ],
        value.to_string(),
    )
        .into_response()
}

fn structured_tool_result(value: Value) -> Value {
    let text = serde_json::to_string_pretty(&value)
        .unwrap_or_else(|error| json!({ "error": error.to_string() }).to_string());
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": value,
        "isError": false
    })
}

fn structured_tool_error(error: &DesktopError) -> Value {
    let structured = match error {
        DesktopError::Cloud {
            status,
            code,
            request_id,
            details,
        } => json!({
            "error": code,
            "status": status,
            "requestId": request_id,
            "details": details,
        }),
        _ => json!({ "error": "tool_failed" }),
    };
    json!({
        "content": [{ "type": "text", "text": error.to_string() }],
        "structuredContent": structured,
        "isError": true
    })
}

fn rpc_success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Option<Value>, code: i32, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn codex_config_snippet(endpoint: &str, token: &str) -> String {
    format!(
        "[mcp_servers.pokedex]\nurl = \"{}\"\nhttp_headers = {{ Authorization = \"Bearer {}\" }}",
        escape_toml(endpoint),
        escape_toml(token)
    )
}

fn escape_toml(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn tool_definitions() -> Value {
    json!([
        read_tool(
            ToolName::CatalogueSearch.as_str(),
            "Search the private card catalogue for possible matches.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 1, "maxLength": 200, "pattern": ".*\\S.*" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            true
        ),
        read_tool(
            ToolName::CardGet.as_str(),
            "Read one catalogue card, including ownership and price data.",
            id_schema("cardId"),
            true
        ),
        read_tool(
            ToolName::BindersList.as_str(),
            "List the owner's binder plans.",
            empty_schema(),
            true
        ),
        read_tool(
            ToolName::BinderGet.as_str(),
            "Read one binder version, its slots, and shortages.",
            id_schema("versionId"),
            true
        ),
        read_tool(
            ToolName::BinderSuggest.as_str(),
            "Read shortages and empty slots for a binder version.",
            id_schema("versionId"),
            true
        ),
        read_tool(
            ToolName::BinderAssignmentCandidates.as_str(),
            "List owned physical card copies available for a binder target.",
            json!({"type":"object","properties":{
                "versionId":{"type":"string","minLength":1,"maxLength":128,"pattern":".*\\S.*"},"at":slot_location_schema()
            },"required":["versionId","at"],"additionalProperties":false}),
            true
        ),
        read_tool(
            ToolName::PendingScansList.as_str(),
            "List local card captures waiting for confirmation.",
            empty_schema(),
            false
        ),
        read_tool(
            ToolName::PendingScanImage.as_str(),
            "Read one pending local capture as image content.",
            id_schema("scanId"),
            false
        ),
        write_tool(
            ToolName::ConfirmScan.as_str(),
            "Confirm a card match, increment its quantity, then delete the local capture.",
            json!({
                "type": "object",
                "properties": {
                    "scanId": { "type": "string", "format": "uuid" },
                    "cardId": { "type": "string", "minLength": 1, "maxLength": 128, "pattern": ".*\\S.*" },
                    "confirmed": { "const": true }
                },
                "required": ["scanId", "cardId", "confirmed"],
                "additionalProperties": false
            }),
            true,
            false
        ),
        write_tool(
            ToolName::CollectionSet.as_str(),
            "Set a card's owned quantity and notes.",
            json!({
                "type": "object",
                "properties": {
                    "cardId": { "type": "string", "minLength": 1, "maxLength": 128, "pattern": ".*\\S.*" },
                    "quantity": { "type": "integer", "minimum": 0, "maximum": 9999 },
                    "expectedRevision": { "type": "integer", "minimum": 0 },
                    "notes": { "type": ["string", "null"], "maxLength": 2000 }
                },
                "required": ["cardId", "quantity", "notes", "expectedRevision"],
                "additionalProperties": false
            }),
            false,
            true
        ),
        write_tool(
            ToolName::CollectionNotes.as_str(),
            "Update notes while preserving the card's current quantity.",
            json!({
                "type": "object",
                "properties": {
                    "cardId": { "type": "string", "minLength": 1, "maxLength": 128, "pattern": ".*\\S.*" },
                    "notes": { "type": ["string", "null"], "maxLength": 2000 }
                    ,"expectedRevision": { "type": "integer", "minimum": 0 }
                },
                "required": ["cardId", "notes", "expectedRevision"],
                "additionalProperties": false
            }),
            false,
            true
        ),
        write_tool(
            ToolName::BinderCreateDraft.as_str(),
            "Create an editable binder with a standard or custom layout.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "minLength": 1, "maxLength": 120, "pattern": ".*\\S.*" },
                    "layout": binder_layout_schema(),
                    "capacity": { "type": "integer", "minimum": 1 }
                },
                "required": ["name", "layout"],
                "additionalProperties": false
            }),
            false,
            false
        ),
        write_tool(
            ToolName::BinderSlotSet.as_str(),
            "Place or clear a card in one slot of the current binder version.",
            json!({
                "type": "object",
                "properties": {
                    "versionId": { "type": "string", "minLength": 1, "maxLength": 128, "pattern": ".*\\S.*" },
                    "expectedRevision": { "type": "integer", "minimum": 1 },
                    "page": { "type": "integer", "minimum": 0 },
                    "row": { "type": "integer", "minimum": 0 },
                    "column": { "type": "integer", "minimum": 0 },
                    "cardId": { "type": ["string", "null"], "minLength": 1, "maxLength": 128, "pattern": ".*\\S.*" }
                },
                "required": ["versionId", "expectedRevision", "page", "row", "column", "cardId"],
                "additionalProperties": false
            }),
            false,
            true
        ),
        write_tool(
            ToolName::BinderSlotSwap.as_str(),
            "Atomically swap two slots in the current binder version.",
            json!({
                "type": "object",
                "properties": {
                    "versionId": { "type": "string", "minLength": 1, "maxLength": 128, "pattern": ".*\\S.*" },
                    "expectedRevision": { "type": "integer", "minimum": 1 },
                    "source": slot_location_schema(),
                    "target": slot_location_schema()
                },
                "required": ["versionId", "expectedRevision", "source", "target"],
                "additionalProperties": false
            }),
            true,
            true
        ),
        write_tool(
            ToolName::BinderInsert.as_str(),
            "Insert binder targets at a slot, shifting later entries.",
            binder_insert_schema(),
            false,
            true
        ),
        write_tool(
            ToolName::BinderRemove.as_str(),
            "Remove one binder entry and compact later entries.",
            binder_location_revision_schema(),
            true,
            true
        ),
        write_tool(
            ToolName::BinderMove.as_str(),
            "Move a binder entry by an explicit signed offset.",
            json!({"type":"object","properties":{
                "versionId":{"type":"string","minLength":1,"maxLength":128,"pattern":".*\\S.*"},
                "expectedRevision":{"type":"integer","minimum":1},
                "from":slot_location_schema(),"offset":{"type":"integer","minimum":-120000,"maximum":120000,"not":{"const":0}}
            },"required":["versionId","expectedRevision","from","offset"],"additionalProperties":false}),
            false,
            true
        ),
        write_tool(
            ToolName::BinderAssign.as_str(),
            "Assign or clear a physical card copy for a binder target.",
            json!({"type":"object","properties":{
                "versionId":{"type":"string","minLength":1,"maxLength":128,"pattern":".*\\S.*"},"expectedRevision":{"type":"integer","minimum":1},"at":slot_location_schema(),"cardId":{"type":["string","null"],"minLength":1,"maxLength":128,"pattern":".*\\S.*"}
            },"required":["versionId","expectedRevision","at","cardId"],"additionalProperties":false}),
            true,
            true
        ),
        write_tool(
            ToolName::BinderPageBreak.as_str(),
            "Toggle the page-break rule on a binder target.",
            json!({"type":"object","properties":{
                "versionId":{"type":"string","minLength":1,"maxLength":128,"pattern":".*\\S.*"},"expectedRevision":{"type":"integer","minimum":1},"at":slot_location_schema(),"startsNewPage":{"type":"boolean"}
            },"required":["versionId","expectedRevision","at","startsNewPage"],"additionalProperties":false}),
            false,
            true
        ),
        write_tool(
            ToolName::BinderReservePage.as_str(),
            "Reserve or release a whole binder page.",
            json!({"type":"object","properties":{
                "versionId":{"type":"string","minLength":1,"maxLength":128,"pattern":".*\\S.*"},"expectedRevision":{"type":"integer","minimum":1},"page":{"type":"integer","minimum":0},"reserved":{"type":"boolean"},"label":optional_label_schema()
            },"required":["versionId","expectedRevision","page","reserved"],"additionalProperties":false}),
            true,
            true
        ),
        write_tool(
            ToolName::BinderResize.as_str(),
            "Explicitly resize binder pocket capacity.",
            json!({"type":"object","properties":{
                "versionId":{"type":"string","minLength":1,"maxLength":128,"pattern":".*\\S.*"},"expectedRevision":{"type":"integer","minimum":1},"capacity":{"type":"integer","minimum":1}
            },"required":["versionId","expectedRevision","capacity"],"additionalProperties":false}),
            true,
            true
        ),
        write_tool(
            ToolName::BinderFullPokedex.as_str(),
            "Insert the full National Pokédex as unassigned targets.",
            json!({"type":"object","properties":{
                "versionId":{"type":"string","minLength":1,"maxLength":128,"pattern":".*\\S.*"},"expectedRevision":{"type":"integer","minimum":1},"at":slot_location_schema(),"regionPageBreaks":{"type":"boolean","default":true}
            },"required":["versionId","expectedRevision","at"],"additionalProperties":false}),
            true,
            true
        )
    ])
}

fn binder_location_revision_schema() -> Value {
    json!({"type":"object","properties":{
        "versionId":{"type":"string","minLength":1,"maxLength":128,"pattern":".*\\S.*"},"expectedRevision":{"type":"integer","minimum":1},"at":slot_location_schema()
    },"required":["versionId","expectedRevision","at"],"additionalProperties":false})
}

fn binder_insert_schema() -> Value {
    json!({"type":"object","properties":{
        "versionId":{"type":"string","minLength":1,"maxLength":128,"pattern":".*\\S.*"},"expectedRevision":{"type":"integer","minimum":1},"at":slot_location_schema(),
        "entries":{"type":"array","minItems":1,"maxItems":1025,"items":binder_entry_schema()}
    },"required":["versionId","expectedRevision","at","entries"],"additionalProperties":false})
}

fn binder_entry_schema() -> Value {
    json!({"oneOf":[
        {"type":"object","properties":{"kind":{"const":"empty"}},"required":["kind"],"additionalProperties":false},
        {"type":"object","properties":{"kind":{"const":"reserved"},"label":optional_label_schema()},"required":["kind"],"additionalProperties":false},
        {"type":"object","properties":{"kind":{"const":"exact-card"},"cardId":{"type":"string","minLength":1,"maxLength":128,"pattern":".*\\S.*"},"startsNewPage":{"type":"boolean"}},"required":["kind","cardId"],"additionalProperties":false},
        {"type":"object","properties":{"kind":{"const":"pokemon"},"pokemonNumber":{"type":"integer","minimum":1,"maximum":1025},"startsNewPage":{"type":"boolean"}},"required":["kind","pokemonNumber"],"additionalProperties":false}
    ]})
}

fn optional_label_schema() -> Value {
    json!({"type":["string", "null"], "minLength":1, "maxLength":120, "pattern":".*\\S.*"})
}

fn cloud_request_id(error: &DesktopError) -> Option<&str> {
    match error {
        DesktopError::Cloud { request_id, .. } => request_id.as_deref(),
        _ => None,
    }
}

fn read_tool(name: &str, description: &str, input_schema: Value, open_world: bool) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
        "outputSchema": { "type": "object", "additionalProperties": true },
        "annotations": {
            "readOnlyHint": true,
            "destructiveHint": false,
            "idempotentHint": true,
            "openWorldHint": open_world
        }
    })
}

fn write_tool(
    name: &str,
    description: &str,
    input_schema: Value,
    destructive: bool,
    idempotent: bool,
) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
        "outputSchema": { "type": "object", "additionalProperties": true },
        "annotations": {
            "readOnlyHint": false,
            "destructiveHint": destructive,
            "idempotentHint": idempotent,
            "openWorldHint": true
        }
    })
}

fn empty_schema() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

fn id_schema(name: &str) -> Value {
    json!({
        "type": "object",
        "properties": { (name): { "type": "string", "minLength": 1, "maxLength": 128, "pattern": ".*\\S.*" } },
        "required": [name],
        "additionalProperties": false
    })
}

fn slot_location_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "page": { "type": "integer", "minimum": 0 },
            "row": { "type": "integer", "minimum": 0 },
            "column": { "type": "integer", "minimum": 0 }
        },
        "required": ["page", "row", "column"],
        "additionalProperties": false
    })
}

fn binder_layout_schema() -> Value {
    json!({ "oneOf": [
        { "type": "object", "properties": { "kind": { "const": "2x2" }, "rows": { "const": 2 }, "columns": { "const": 2 } }, "required": ["kind", "rows", "columns"], "additionalProperties": false },
        { "type": "object", "properties": { "kind": { "const": "3x3" }, "rows": { "const": 3 }, "columns": { "const": 3 } }, "required": ["kind", "rows", "columns"], "additionalProperties": false },
        { "type": "object", "properties": { "kind": { "const": "4x3" }, "rows": { "const": 3 }, "columns": { "const": 4 } }, "required": ["kind", "rows", "columns"], "additionalProperties": false },
        { "type": "object", "properties": { "kind": { "const": "top-loader" }, "rows": { "const": 2 }, "columns": { "const": 2 } }, "required": ["kind", "rows", "columns"], "additionalProperties": false },
        { "type": "object", "properties": { "kind": { "const": "custom" }, "rows": { "type": "integer", "minimum": 1, "maximum": 20 }, "columns": { "type": "integer", "minimum": 1, "maximum": 20 } }, "required": ["kind", "rows", "columns"], "additionalProperties": false }
    ] })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    struct FakeBackend;

    struct CapacityErrorBackend;

    #[async_trait]
    impl McpBackend for FakeBackend {
        async fn call_tool(&self, name: ToolName, arguments: Value) -> Result<ToolPayload> {
            if name == ToolName::PendingScanImage {
                return Ok(ToolPayload::Image {
                    mime_type: "image/webp".to_string(),
                    base64_data: "UklGRgQAAABXRUJQZGF0YQ==".to_string(),
                    metadata: json!({ "scanId": arguments["scanId"] }),
                });
            }
            Ok(ToolPayload::Structured(json!({ "name": name.as_str() })))
        }
    }

    #[async_trait]
    impl McpBackend for CapacityErrorBackend {
        async fn call_tool(&self, _name: ToolName, _arguments: Value) -> Result<ToolPayload> {
            Err(DesktopError::Cloud {
                status: 409,
                code: "binder_capacity_exceeded".to_string(),
                request_id: Some("request-409".to_string()),
                details: Some(crate::error::CloudErrorDetails::BinderCapacity(
                    crate::error::CloudBinderCapacityDetails {
                        current_capacity: 9,
                        required_capacity: 18,
                        additional_pockets: 9,
                        page_increment: 9,
                    },
                )),
            })
        }
    }

    fn request(body: Value, token: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/mcp")
            .header(header::HOST, "127.0.0.1:47837")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json")
            .header(MCP_PROTOCOL_HEADER, MCP_PROTOCOL_VERSION)
            .body(Body::from(body.to_string()))
            .expect("request")
    }

    async fn response_json(response: Response) -> Value {
        serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("response bytes"),
        )
        .expect("response JSON")
    }

    fn assert_nonempty_string_schemas_reject_whitespace(value: &Value) {
        match value {
            Value::Array(values) => {
                for value in values {
                    assert_nonempty_string_schemas_reject_whitespace(value);
                }
            }
            Value::Object(object) => {
                let string_type = object.get("type").is_some_and(|kind| {
                    kind == "string"
                        || kind
                            .as_array()
                            .is_some_and(|kinds| kinds.iter().any(|kind| kind == "string"))
                });
                if string_type && object.get("minLength") == Some(&json!(1)) {
                    assert_eq!(
                        object.get("pattern"),
                        Some(&json!(".*\\S.*")),
                        "non-empty MCP strings must reject whitespace-only values: {value}"
                    );
                }
                for value in object.values() {
                    assert_nonempty_string_schemas_reject_whitespace(value);
                }
            }
            _ => {}
        }
    }

    #[tokio::test]
    async fn initialize_and_tools_list_follow_streamable_http_json_rpc() {
        let app = router("secret".to_string(), Arc::new(FakeBackend));
        let initialize = app
            .clone()
            .oneshot(request(
                json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": MCP_PROTOCOL_VERSION,
                        "capabilities": {},
                        "clientInfo": { "name": "test", "version": "1" }
                    }
                }),
                "secret",
            ))
            .await
            .expect("initialize response");
        let initialized = response_json(initialize).await;
        assert_eq!(
            initialized["result"]["protocolVersion"],
            MCP_PROTOCOL_VERSION
        );

        let list = app
            .oneshot(request(
                json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
                "secret",
            ))
            .await
            .expect("tools response");
        let listed = response_json(list).await;
        let tools = listed["result"]["tools"].as_array().expect("tools array");
        assert!(tools.iter().any(|tool| {
            tool["name"] == "pokedex_confirm_scan"
                && tool["annotations"]["readOnlyHint"] == false
                && tool["annotations"]["destructiveHint"] == true
        }));
        assert!(tools
            .iter()
            .any(|tool| tool["name"] == "pokedex_binder_suggest"));
        let reserve = tools
            .iter()
            .find(|tool| tool["name"] == "pokedex_binder_reserve_page")
            .expect("reserved page tool");
        assert!(!reserve["inputSchema"]["required"]
            .as_array()
            .expect("required fields")
            .iter()
            .any(|field| field == "label"));
        assert_eq!(
            reserve["inputSchema"]["properties"]["label"]["minLength"],
            1
        );
        let candidates = tools
            .iter()
            .find(|tool| tool["name"] == "pokedex_binder_assignment_candidates")
            .expect("assignment candidates tool");
        assert_eq!(
            candidates["inputSchema"]["required"],
            json!(["versionId", "at"])
        );
        let create = tools
            .iter()
            .find(|tool| tool["name"] == "pokedex_binder_create_draft")
            .expect("create binder tool");
        assert_eq!(
            create["inputSchema"]["properties"]["layout"]["oneOf"][1]["properties"]["rows"]
                ["const"],
            3
        );
        let insert = tools
            .iter()
            .find(|tool| tool["name"] == "pokedex_binder_insert")
            .expect("insert tool");
        assert_eq!(
            insert["inputSchema"]["properties"]["entries"]["maxItems"],
            1025
        );
        assert_eq!(
            insert["inputSchema"]["properties"]["entries"]["items"]["oneOf"][1]["properties"]
                ["label"]["minLength"],
            1
        );
        assert_eq!(tools.len(), ToolName::ALL.len());
        for tool in tools {
            assert_nonempty_string_schemas_reject_whitespace(&tool["inputSchema"]);
        }
        for tool in ToolName::ALL {
            assert_eq!(
                tools
                    .iter()
                    .filter(|definition| definition["name"] == tool.as_str())
                    .count(),
                1,
                "tool registry must list {} exactly once",
                tool.as_str()
            );
        }
    }

    #[tokio::test]
    async fn binder_suggestion_tool_is_callable() {
        let app = router("secret".to_string(), Arc::new(FakeBackend));
        let response = app
            .oneshot(request(
                json!({
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {
                        "name": "pokedex_binder_suggest",
                        "arguments": { "versionId": "binder-version-1" }
                    }
                }),
                "secret",
            ))
            .await
            .expect("suggestion response");
        let value = response_json(response).await;
        assert_eq!(
            value["result"]["structuredContent"]["name"],
            "pokedex_binder_suggest"
        );
    }

    #[tokio::test]
    async fn cloud_tool_errors_preserve_request_id_and_recovery_details() {
        let app = router("secret".to_string(), Arc::new(CapacityErrorBackend));
        let response = app
            .oneshot(request(
                json!({
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "tools/call",
                    "params": {
                        "name": "pokedex_binder_resize",
                        "arguments": {
                            "versionId": "version-1",
                            "expectedRevision": 2,
                            "capacity": 18
                        }
                    }
                }),
                "secret",
            ))
            .await
            .expect("capacity error response");
        let value = response_json(response).await;
        assert_eq!(value["result"]["isError"], true);
        assert_eq!(
            value["result"]["structuredContent"],
            json!({
                "error": "binder_capacity_exceeded",
                "status": 409,
                "requestId": "request-409",
                "details": {
                    "currentCapacity": 9,
                    "requiredCapacity": 18,
                    "additionalPockets": 9,
                    "pageIncrement": 9
                }
            })
        );
    }

    #[tokio::test]
    async fn tools_call_can_return_mcp_image_content() {
        let app = router("secret".to_string(), Arc::new(FakeBackend));
        let response = app
            .oneshot(request(
                json!({
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "pokedex_pending_scan_image",
                        "arguments": { "scanId": "01909a91-2fd5-77e0-b7e9-962c6f8b57ec" }
                    }
                }),
                "secret",
            ))
            .await
            .expect("image response");
        let value = response_json(response).await;
        assert_eq!(value["result"]["content"][0]["type"], "image");
        assert_eq!(value["result"]["content"][0]["mimeType"], "image/webp");
        assert_eq!(
            value["result"]["content"][0]["data"],
            "UklGRgQAAABXRUJQZGF0YQ=="
        );
    }

    #[tokio::test]
    async fn bearer_host_and_origin_are_all_enforced() {
        let app = router("secret".to_string(), Arc::new(FakeBackend));
        let unauthorized = app
            .clone()
            .oneshot(request(
                json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }),
                "wrong",
            ))
            .await
            .expect("unauthorized response");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let hostile_host = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header(header::HOST, "attacker.example")
            .header(header::AUTHORIZATION, "Bearer secret")
            .body(Body::from(
                json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string(),
            ))
            .expect("request");
        assert_eq!(
            app.clone()
                .oneshot(hostile_host)
                .await
                .expect("host response")
                .status(),
            StatusCode::FORBIDDEN
        );

        let hostile_origin = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header(header::HOST, "127.0.0.1:47837")
            .header(header::ORIGIN, "https://attacker.example")
            .header(header::AUTHORIZATION, "Bearer secret")
            .body(Body::from(
                json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }).to_string(),
            ))
            .expect("request");
        assert_eq!(
            app.oneshot(hostile_origin)
                .await
                .expect("origin response")
                .status(),
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn initialize_rejects_unsupported_protocol_and_later_calls_require_header() {
        let app = router("secret".to_string(), Arc::new(FakeBackend));
        let unsupported = app
            .clone()
            .oneshot(request(
                json!({
                    "jsonrpc": "2.0",
                    "id": 8,
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": { "name": "test", "version": "1" }
                    }
                }),
                "secret",
            ))
            .await
            .expect("unsupported protocol response");
        assert_eq!(response_json(unsupported).await["error"]["code"], -32602);

        let without_version = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header(header::HOST, "127.0.0.1:47837")
            .header(header::AUTHORIZATION, "Bearer secret")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json")
            .body(Body::from(
                json!({ "jsonrpc": "2.0", "id": 9, "method": "ping" }).to_string(),
            ))
            .expect("request");
        assert_eq!(
            app.oneshot(without_version)
                .await
                .expect("missing version response")
                .status(),
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn failed_replacement_bind_does_not_replace_the_live_status() {
        let occupied = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("occupied listener");
        let port = occupied.local_addr().expect("occupied address").port();
        let original = McpStatus {
            endpoint: "http://127.0.0.1:47837/mcp".to_string(),
            config_snippet: "existing".to_string(),
            running: true,
            error: None,
        };
        let live_status = Arc::new(RwLock::new(original.clone()));
        let generation = Arc::new(AtomicU64::new(1));

        let error = start(
            port,
            "secret".to_string(),
            Arc::new(FakeBackend),
            live_status.clone(),
            2,
            generation,
        )
        .await
        .expect_err("occupied port must fail");

        assert_eq!(*live_status.read().await, original);
        assert!(error.to_string().contains("Address already in use"));
    }

    #[tokio::test]
    async fn stale_server_generation_cannot_overwrite_replacement_status() {
        let replacement = McpStatus {
            endpoint: "http://127.0.0.1:47838/mcp".to_string(),
            config_snippet: "replacement".to_string(),
            running: true,
            error: None,
        };
        let status = RwLock::new(replacement.clone());
        let generation = AtomicU64::new(2);

        publish_stopped_status(&status, &generation, 1, "old server stopped".to_string()).await;
        assert_eq!(*status.read().await, replacement);

        publish_stopped_status(&status, &generation, 2, "new server stopped".to_string()).await;
        let stopped = status.read().await;
        assert!(!stopped.running);
        assert_eq!(stopped.error.as_deref(), Some("new server stopped"));
    }

    #[test]
    fn server_address_is_always_ipv4_loopback() {
        assert_eq!(
            bind_address(47837),
            "127.0.0.1:47837".parse().expect("socket")
        );
    }
}
