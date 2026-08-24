use crate::error::Result;
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
use std::sync::Arc;
use subtle::ConstantTimeEq;

pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub endpoint: String,
    pub bearer_token: String,
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

#[async_trait]
pub trait McpBackend: Send + Sync {
    async fn call_tool(&self, name: &str, arguments: Value) -> Result<ToolPayload>;
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

pub fn bind_address(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

pub async fn start(port: u16, token: String, backend: Arc<dyn McpBackend>) -> Result<McpStatus> {
    let listener = tokio::net::TcpListener::bind(bind_address(port)).await?;
    let address = listener.local_addr()?;
    let endpoint = format!("http://127.0.0.1:{}/mcp", address.port());
    let status = McpStatus {
        config_snippet: codex_config_snippet(&endpoint, &token),
        endpoint,
        bearer_token: token.clone(),
        running: true,
        error: None,
    };
    let router = router(token, backend);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            tracing::error!(error = %error, "local MCP server stopped");
        }
    });
    Ok(status)
}

pub fn unavailable_status(port: u16, token: String, error: String) -> McpStatus {
    let endpoint = format!("http://127.0.0.1:{port}/mcp");
    McpStatus {
        config_snippet: codex_config_snippet(&endpoint, &token),
        endpoint,
        bearer_token: token,
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
        return response;
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
        return response;
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
    let Some(id) = request.id.clone() else {
        return StatusCode::ACCEPTED.into_response();
    };
    let result = handle_request(&state, request, id).await;
    json_response(StatusCode::OK, result)
}

async fn handle_request(state: &McpState, request: JsonRpcRequest, id: Value) -> Value {
    match request.method.as_deref() {
        Some("initialize") => rpc_success(
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
        ),
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
    let name = name.to_string();
    if !is_known_tool(&name) {
        return rpc_error(Some(id), -32601, format!("Unknown tool: {name}"));
    }
    let arguments = params
        .and_then(|value| value.get("arguments").cloned())
        .unwrap_or_else(|| json!({}));
    match state.backend.call_tool(&name, arguments).await {
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
        Err(error) => rpc_success(
            id,
            json!({
                "content": [{ "type": "text", "text": error.to_string() }],
                "isError": true
            }),
        ),
    }
}

fn authorize(headers: &HeaderMap, expected: &str) -> std::result::Result<(), Response> {
    if !valid_loopback_host(headers) || !valid_origin(headers) {
        return Err((StatusCode::FORBIDDEN, "Loopback requests only").into_response());
    }
    let supplied = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));
    if supplied.is_some_and(|token| constant_time_equal(token, expected)) {
        Ok(())
    } else {
        Err((StatusCode::UNAUTHORIZED, "Unauthorized").into_response())
    }
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
        [(header::CONTENT_TYPE, "application/json")],
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

fn is_known_tool(name: &str) -> bool {
    matches!(
        name,
        "pokedex_catalogue_search"
            | "pokedex_card_get"
            | "pokedex_binders_list"
            | "pokedex_binder_get"
            | "pokedex_binder_suggest"
            | "pokedex_pending_scans_list"
            | "pokedex_pending_scan_image"
            | "pokedex_confirm_scan"
            | "pokedex_collection_set"
            | "pokedex_collection_notes"
            | "pokedex_binder_create_draft"
            | "pokedex_binder_slot_set"
    )
}

fn tool_definitions() -> Value {
    json!([
        read_tool(
            "pokedex_catalogue_search",
            "Search the private card catalogue for possible matches.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            true
        ),
        read_tool(
            "pokedex_card_get",
            "Read one catalogue card, including ownership and price data.",
            id_schema("cardId"),
            true
        ),
        read_tool(
            "pokedex_binders_list",
            "List the owner's binder plans.",
            empty_schema(),
            true
        ),
        read_tool(
            "pokedex_binder_get",
            "Read one binder version, its slots, and shortages.",
            id_schema("versionId"),
            true
        ),
        read_tool(
            "pokedex_binder_suggest",
            "Read shortages and empty slots for a binder version.",
            id_schema("versionId"),
            true
        ),
        read_tool(
            "pokedex_pending_scans_list",
            "List local card captures waiting for confirmation.",
            empty_schema(),
            false
        ),
        read_tool(
            "pokedex_pending_scan_image",
            "Read one pending local capture as image content.",
            id_schema("scanId"),
            false
        ),
        write_tool(
            "pokedex_confirm_scan",
            "Confirm a card match, increment its quantity, then delete the local capture.",
            json!({
                "type": "object",
                "properties": {
                    "scanId": { "type": "string", "format": "uuid" },
                    "cardId": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "confirmed": { "const": true }
                },
                "required": ["scanId", "cardId", "confirmed"],
                "additionalProperties": false
            }),
            true,
            false
        ),
        write_tool(
            "pokedex_collection_set",
            "Set a card's owned quantity and notes.",
            json!({
                "type": "object",
                "properties": {
                    "cardId": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "quantity": { "type": "integer", "minimum": 0, "maximum": 9999 },
                    "notes": { "type": ["string", "null"], "maxLength": 2000 }
                },
                "required": ["cardId", "quantity", "notes"],
                "additionalProperties": false
            }),
            false,
            true
        ),
        write_tool(
            "pokedex_collection_notes",
            "Update notes while preserving the card's current quantity.",
            json!({
                "type": "object",
                "properties": {
                    "cardId": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "notes": { "type": ["string", "null"], "maxLength": 2000 }
                },
                "required": ["cardId", "notes"],
                "additionalProperties": false
            }),
            false,
            true
        ),
        write_tool(
            "pokedex_binder_create_draft",
            "Create a draft binder with a standard or custom layout.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "minLength": 1, "maxLength": 120 },
                    "layout": {
                        "type": "object",
                        "properties": {
                            "kind": { "enum": ["2x2", "3x3", "4x3", "top-loader", "custom"] },
                            "rows": { "type": "integer", "minimum": 1, "maximum": 20 },
                            "columns": { "type": "integer", "minimum": 1, "maximum": 20 }
                        },
                        "required": ["kind", "rows", "columns"],
                        "additionalProperties": false
                    }
                },
                "required": ["name", "layout"],
                "additionalProperties": false
            }),
            false,
            false
        ),
        write_tool(
            "pokedex_binder_slot_set",
            "Place or clear a card in one slot of a draft binder version.",
            json!({
                "type": "object",
                "properties": {
                    "versionId": { "type": "string", "minLength": 1, "maxLength": 128 },
                    "page": { "type": "integer", "minimum": 0 },
                    "row": { "type": "integer", "minimum": 0 },
                    "column": { "type": "integer", "minimum": 0 },
                    "cardId": { "type": ["string", "null"], "maxLength": 128 }
                },
                "required": ["versionId", "page", "row", "column", "cardId"],
                "additionalProperties": false
            }),
            false,
            true
        )
    ])
}

fn read_tool(name: &str, description: &str, input_schema: Value, open_world: bool) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
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
        "properties": { (name): { "type": "string", "minLength": 1, "maxLength": 128 } },
        "required": [name],
        "additionalProperties": false
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    struct FakeBackend;

    #[async_trait]
    impl McpBackend for FakeBackend {
        async fn call_tool(&self, name: &str, arguments: Value) -> Result<ToolPayload> {
            if name == "pokedex_pending_scan_image" {
                return Ok(ToolPayload::Image {
                    mime_type: "image/webp".to_string(),
                    base64_data: "UklGRgQAAABXRUJQZGF0YQ==".to_string(),
                    metadata: json!({ "scanId": arguments["scanId"] }),
                });
            }
            Ok(ToolPayload::Structured(json!({ "name": name })))
        }
    }

    fn request(body: Value, token: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/mcp")
            .header(header::HOST, "127.0.0.1:47837")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
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

    #[tokio::test]
    async fn initialize_and_tools_list_follow_streamable_http_json_rpc() {
        let app = router("secret".to_string(), Arc::new(FakeBackend));
        let initialize = app
            .clone()
            .oneshot(request(
                json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }),
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

    #[test]
    fn server_address_is_always_ipv4_loopback() {
        assert_eq!(
            bind_address(47837),
            "127.0.0.1:47837".parse().expect("socket")
        );
    }
}
