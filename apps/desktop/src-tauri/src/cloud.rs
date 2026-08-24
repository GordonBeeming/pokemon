use crate::error::{DesktopError, Result};
use futures_util::StreamExt;
use reqwest::{Method, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use tokio::io::AsyncWriteExt;
use url::Url;

#[derive(Debug, Clone)]
pub struct CloudClient {
    http: reqwest::Client,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairingResult {
    pub token: String,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ArtManifestEntry {
    pub card_id: String,
    pub variant: ArtVariant,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ArtVariant {
    High,
    Low,
}

impl ArtVariant {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::High => "high",
            Self::Low => "low",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtManifestPage {
    pub entries: Vec<ArtManifestEntry>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueSourceEntry {
    pub card_id: String,
    pub provider: String,
    pub source_id: String,
    pub language: String,
    pub source_updated_at: u64,
    pub source_checksum: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueSourcePage {
    pub entries: Vec<CatalogueSourceEntry>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadTicket {
    pub token: String,
    pub upload_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadMode {
    Restarted,
    Resumed,
}

#[derive(Debug, Deserialize)]
struct PairResponse {
    token: String,
    scopes: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ManifestResponse {
    entries: Vec<ArtManifestEntry>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CatalogueSourceResponse {
    entries: Vec<CatalogueSourceEntry>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadTicketResponse {
    token: String,
    upload_path: String,
}

#[derive(Debug, Deserialize)]
struct ApiFailure {
    error: String,
}

impl CloudClient {
    pub fn new() -> Result<Self> {
        let http = reqwest::Client::builder()
            .https_only(false)
            .user_agent(concat!("pokedex-desktop/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self { http })
    }

    pub async fn redeem_pairing_code(
        &self,
        base_url: &str,
        code: &str,
        label: &str,
    ) -> Result<PairingResult> {
        let response: PairResponse = self
            .send_json(
                self.http
                    .post(api_url(base_url, "/api/desktop/pair/redeem")?)
                    .json(&json!({ "code": code.trim(), "label": label.trim() })),
            )
            .await?;
        if response.token.trim().is_empty() {
            return Err(DesktopError::InvalidCloudResponse(
                "pairing response contained an empty token".to_string(),
            ));
        }
        Ok(PairingResult {
            token: response.token,
            scopes: response.scopes,
        })
    }

    pub async fn catalogue_search(
        &self,
        base_url: &str,
        token: &str,
        query: &str,
        limit: u16,
    ) -> Result<Value> {
        self.authorized_json(
            Method::GET,
            base_url,
            "/api/desktop/catalogue/search",
            token,
            None,
            &[
                ("q", query.to_string()),
                ("limit", limit.min(100).to_string()),
            ],
        )
        .await
    }

    pub async fn card(&self, base_url: &str, token: &str, card_id: &str) -> Result<Value> {
        self.authorized_json(
            Method::GET,
            base_url,
            &format!(
                "/api/desktop/catalogue/{}",
                percent_encoding::utf8_percent_encode(card_id, percent_encoding::NON_ALPHANUMERIC)
            ),
            token,
            None,
            &[],
        )
        .await
    }

    pub async fn list_binders(&self, base_url: &str, token: &str) -> Result<Value> {
        self.authorized_json(
            Method::GET,
            base_url,
            "/api/desktop/binders",
            token,
            None,
            &[],
        )
        .await
    }

    pub async fn binder(&self, base_url: &str, token: &str, version_id: &str) -> Result<Value> {
        self.authorized_json(
            Method::GET,
            base_url,
            &format!(
                "/api/desktop/binders/versions/{}",
                percent_encoding::utf8_percent_encode(
                    version_id,
                    percent_encoding::NON_ALPHANUMERIC
                )
            ),
            token,
            None,
            &[],
        )
        .await
    }

    pub async fn binder_suggestions(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
    ) -> Result<Value> {
        self.authorized_json(
            Method::GET,
            base_url,
            &format!(
                "/api/desktop/binders/versions/{}/suggest",
                percent_encoding::utf8_percent_encode(
                    version_id,
                    percent_encoding::NON_ALPHANUMERIC
                )
            ),
            token,
            None,
            &[],
        )
        .await
    }

    pub async fn set_collection(
        &self,
        base_url: &str,
        token: &str,
        card_id: &str,
        quantity: u32,
        notes: Option<&str>,
        mutation_id: uuid::Uuid,
    ) -> Result<Value> {
        self.authorized_json(
            Method::PUT,
            base_url,
            &format!(
                "/api/desktop/collection/{}",
                percent_encoding::utf8_percent_encode(card_id, percent_encoding::NON_ALPHANUMERIC)
            ),
            token,
            Some(json!({
                "quantity": quantity,
                "notes": notes,
                "mutationId": mutation_id,
            })),
            &[],
        )
        .await
    }

    pub async fn create_binder(
        &self,
        base_url: &str,
        token: &str,
        name: &str,
        layout: Value,
    ) -> Result<Value> {
        self.authorized_json(
            Method::POST,
            base_url,
            "/api/desktop/binders",
            token,
            Some(json!({ "name": name, "layout": layout })),
            &[],
        )
        .await
    }

    pub async fn set_binder_slot(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
        slot: Value,
    ) -> Result<Value> {
        self.authorized_json(
            Method::PUT,
            base_url,
            &format!(
                "/api/desktop/binders/versions/{}/slot",
                percent_encoding::utf8_percent_encode(
                    version_id,
                    percent_encoding::NON_ALPHANUMERIC
                )
            ),
            token,
            Some(slot),
            &[],
        )
        .await
    }

    pub async fn manifest_page(
        &self,
        base_url: &str,
        token: &str,
        cursor: Option<&str>,
    ) -> Result<ArtManifestPage> {
        let mut query = vec![("limit", "500".to_string())];
        if let Some(cursor) = cursor {
            query.push(("cursor", cursor.to_string()));
        }
        let page: ManifestResponse = self
            .authorized_json(
                Method::GET,
                base_url,
                "/api/desktop/art/manifest",
                token,
                None,
                &query,
            )
            .await?;
        Ok(ArtManifestPage {
            entries: page.entries,
            cursor: page.cursor,
        })
    }

    pub async fn catalogue_source_page(
        &self,
        base_url: &str,
        token: &str,
        cursor: Option<&str>,
    ) -> Result<CatalogueSourcePage> {
        let mut query = vec![("limit", "500".to_string())];
        if let Some(cursor) = cursor {
            query.push(("cursor", cursor.to_string()));
        }
        let page: CatalogueSourceResponse = self
            .authorized_json(
                Method::GET,
                base_url,
                "/api/desktop/catalogue/sources",
                token,
                None,
                &query,
            )
            .await?;
        Ok(CatalogueSourcePage {
            entries: page.entries,
            cursor: page.cursor,
        })
    }

    pub async fn download_art_to(
        &self,
        base_url: &str,
        token: &str,
        entry: &ArtManifestEntry,
        start: u64,
        destination: &Path,
    ) -> Result<DownloadMode> {
        let path = format!(
            "/api/desktop/art/{}/{}",
            percent_encoding::utf8_percent_encode(
                &entry.card_id,
                percent_encoding::NON_ALPHANUMERIC
            ),
            entry.variant.as_str()
        );
        let mut request = self.http.get(api_url(base_url, &path)?).bearer_auth(token);
        if start > 0 {
            request = request.header(reqwest::header::RANGE, format!("bytes={start}-"));
        }
        let response = request.send().await?;
        let status = response.status();
        if status != StatusCode::OK && status != StatusCode::PARTIAL_CONTENT {
            return Err(read_cloud_error(response).await);
        }
        let resume = start > 0 && status == StatusCode::PARTIAL_CONTENT;
        let mut options = tokio::fs::OpenOptions::new();
        options.create(true).write(true);
        if resume {
            options.append(true);
        } else {
            options.truncate(true);
        }
        let mut file = options.open(destination).await?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            file.write_all(&chunk?).await?;
        }
        file.flush().await?;
        file.sync_all().await?;
        Ok(if resume {
            DownloadMode::Resumed
        } else {
            DownloadMode::Restarted
        })
    }

    pub async fn issue_upload_ticket(
        &self,
        base_url: &str,
        token: &str,
        entry: &ArtManifestEntry,
    ) -> Result<UploadTicket> {
        let response: UploadTicketResponse = self
            .authorized_json(
                Method::POST,
                base_url,
                "/api/desktop/art/upload-tokens",
                token,
                Some(json!({
                    "cardId": entry.card_id,
                    "variant": entry.variant,
                    "sha256": entry.sha256,
                    "maxBytes": entry.bytes,
                })),
                &[],
            )
            .await?;
        Ok(UploadTicket {
            token: response.token,
            upload_path: response.upload_path,
        })
    }

    pub async fn upload_art(
        &self,
        base_url: &str,
        ticket: &UploadTicket,
        bytes: Vec<u8>,
    ) -> Result<()> {
        let response = self
            .http
            .put(api_url(base_url, &ticket.upload_path)?)
            .header(reqwest::header::CONTENT_TYPE, "image/webp")
            .header(reqwest::header::CONTENT_LENGTH, bytes.len())
            .body(bytes)
            .send()
            .await?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(read_cloud_error(response).await)
        }
    }

    async fn authorized_json<T: DeserializeOwned>(
        &self,
        method: Method,
        base_url: &str,
        path: &str,
        token: &str,
        body: Option<Value>,
        query: &[(&str, String)],
    ) -> Result<T> {
        if token.trim().is_empty() {
            return Err(DesktopError::NotPaired);
        }
        let mut request = self
            .http
            .request(method, api_url(base_url, path)?)
            .bearer_auth(token)
            .query(
                &query
                    .iter()
                    .map(|(key, value)| (*key, value))
                    .collect::<Vec<_>>(),
            );
        if let Some(body) = body {
            request = request.json(&body);
        }
        self.send_json(request).await
    }

    async fn send_json<T: DeserializeOwned>(&self, request: reqwest::RequestBuilder) -> Result<T> {
        let response = request.send().await?;
        if !response.status().is_success() {
            return Err(read_cloud_error(response).await);
        }
        let value: Value = response.json().await?;
        if value.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(DesktopError::InvalidCloudResponse(
                "successful response did not contain ok: true".to_string(),
            ));
        }
        serde_json::from_value(value).map_err(|error| {
            DesktopError::InvalidCloudResponse(format!("response schema mismatch: {error}"))
        })
    }
}

fn api_url(base_url: &str, path: &str) -> Result<Url> {
    let mut base = Url::parse(base_url)?;
    base.set_path("/");
    base.set_query(None);
    base.set_fragment(None);
    Ok(base.join(path.trim_start_matches('/'))?)
}

async fn read_cloud_error(response: reqwest::Response) -> DesktopError {
    let status = response.status().as_u16();
    let code = response
        .json::<ApiFailure>()
        .await
        .map(|failure| failure.error)
        .unwrap_or_else(|_| "cloud_request_failed".to_string());
    DesktopError::Cloud { status, code }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
    use std::sync::{Arc, Mutex};

    #[derive(Clone)]
    struct Reply(Arc<Mutex<(StatusCode, Value)>>);

    async fn pair_reply(State(reply): State<Reply>) -> (StatusCode, Json<Value>) {
        let value = reply.0.lock().expect("reply lock").clone();
        (value.0, Json(value.1))
    }

    async fn server(status: StatusCode, body: Value) -> (String, Reply) {
        let reply = Reply(Arc::new(Mutex::new((status, body))));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let app = Router::new()
            .route("/api/desktop/pair/redeem", post(pair_reply))
            .with_state(reply.clone());
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("test server");
        });
        (format!("http://{address}"), reply)
    }

    #[tokio::test]
    async fn pairing_expiry_is_reported_without_storing_a_token() {
        let (base, _) = server(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": "pair_code_invalid" }),
        )
        .await;
        let error = CloudClient::new()
            .expect("client")
            .redeem_pairing_code(&base, "expired-code", "Scanner")
            .await
            .expect_err("expired code");
        assert!(
            matches!(error, DesktopError::Cloud { status: 400, code } if code == "pair_code_invalid")
        );
    }

    #[tokio::test]
    async fn pairing_replay_is_distinct_from_expiry() {
        let (base, _) = server(
            StatusCode::CONFLICT,
            json!({ "ok": false, "error": "pair_code_already_consumed" }),
        )
        .await;
        let error = CloudClient::new()
            .expect("client")
            .redeem_pairing_code(&base, "used-code", "Scanner")
            .await
            .expect_err("replayed code");
        assert!(
            matches!(error, DesktopError::Cloud { status: 409, code } if code == "pair_code_already_consumed")
        );
    }

    #[test]
    fn paths_are_joined_under_the_configured_origin() {
        let url =
            api_url("https://example.com/base", "/api/desktop/catalogue/search").expect("API URL");
        assert_eq!(
            url.as_str(),
            "https://example.com/api/desktop/catalogue/search"
        );
    }
}
