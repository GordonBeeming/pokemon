use crate::error::{DesktopError, Result};
use futures_util::StreamExt;
use reqwest::{redirect, Method, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionState {
    pub card_id: String,
    pub quantity: u32,
    pub notes: Option<String>,
    pub revision: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionMutationResult {
    pub state: CollectionState,
    pub replayed: bool,
}

pub struct CollectionSetInput<'a> {
    pub card_id: &'a str,
    pub quantity: u32,
    pub notes: Option<&'a str>,
    pub mutation_id: uuid::Uuid,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderSlot {
    pub page_id: String,
    pub row: u32,
    pub column: u32,
    pub card_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderPage {
    pub id: String,
    pub position: u32,
    pub slots: Vec<BinderSlot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderVersionSummary {
    pub id: String,
    pub binder_id: String,
    pub version_number: u32,
    pub status: String,
    pub layout: Value,
    pub revision: u64,
    pub page_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderVersionPage {
    pub version: BinderVersionSummary,
    pub pages: Vec<BinderPage>,
    pub next_page: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderShortage {
    pub card_id: String,
    pub required: u32,
    pub owned: u32,
    pub missing: u32,
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
struct BulkUploadTicketResponse {
    uploads: Vec<BulkUploadTicket>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BulkUploadTicket {
    card_id: String,
    variant: ArtVariant,
    token: String,
    upload_path: String,
}

#[derive(Debug, Deserialize)]
struct CollectionMutationResponse {
    state: CollectionState,
    replayed: bool,
}

#[derive(Debug, Deserialize)]
struct BinderResponse {
    binder: BinderVersionPage,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BinderShortagesResponse {
    shortages: Vec<BinderShortage>,
    next_offset: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct ApiFailure {
    error: String,
}

impl CloudClient {
    pub fn new() -> Result<Self> {
        let http = reqwest::Client::builder()
            .https_only(false)
            .redirect(redirect::Policy::custom(|attempt| {
                let Some(first) = attempt.previous().first() else {
                    return attempt.follow();
                };
                if same_origin(first, attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.error("cross-origin redirect blocked")
                }
            }))
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
        let response: BinderResponse = self
            .authorized_json(
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
                &[("page", "0".to_string()), ("limit", "1".to_string())],
            )
            .await?;
        serde_json::to_value(response.binder).map_err(Into::into)
    }

    pub async fn binder_suggestions(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
    ) -> Result<Value> {
        let response: BinderShortagesResponse = self
            .authorized_json(
                Method::GET,
                base_url,
                &format!(
                    "/api/desktop/binders/versions/{}/shortages",
                    percent_encoding::utf8_percent_encode(
                        version_id,
                        percent_encoding::NON_ALPHANUMERIC
                    )
                ),
                token,
                None,
                &[("offset", "0".to_string()), ("limit", "100".to_string())],
            )
            .await?;
        serde_json::to_value(json!({
            "shortages": response.shortages,
            "nextOffset": response.next_offset,
        }))
        .map_err(Into::into)
    }

    pub async fn set_collection(
        &self,
        base_url: &str,
        token: &str,
        input: CollectionSetInput<'_>,
    ) -> Result<CollectionMutationResult> {
        let response: CollectionMutationResponse = self
            .authorized_json(
                Method::PUT,
                base_url,
                &format!(
                    "/api/desktop/collection/{}",
                    percent_encoding::utf8_percent_encode(
                        input.card_id,
                        percent_encoding::NON_ALPHANUMERIC
                    )
                ),
                token,
                Some(json!({
                "quantity": input.quantity,
                "notes": input.notes,
                "mutationId": input.mutation_id,
                "expectedRevision": input.expected_revision,
                })),
                &[],
            )
            .await?;
        Ok(CollectionMutationResult {
            state: response.state,
            replayed: response.replayed,
        })
    }

    pub async fn increment_collection(
        &self,
        base_url: &str,
        token: &str,
        card_id: &str,
        delta: u32,
        mutation_id: uuid::Uuid,
    ) -> Result<CollectionMutationResult> {
        let response: CollectionMutationResponse = self
            .authorized_json(
                Method::POST,
                base_url,
                &format!(
                    "/api/desktop/collection/{}/increment",
                    percent_encoding::utf8_percent_encode(
                        card_id,
                        percent_encoding::NON_ALPHANUMERIC
                    )
                ),
                token,
                Some(json!({ "delta": delta, "mutationId": mutation_id })),
                &[],
            )
            .await?;
        Ok(CollectionMutationResult {
            state: response.state,
            replayed: response.replayed,
        })
    }

    pub async fn patch_collection_notes(
        &self,
        base_url: &str,
        token: &str,
        card_id: &str,
        notes: Option<&str>,
        expected_revision: u64,
        mutation_id: uuid::Uuid,
    ) -> Result<CollectionMutationResult> {
        let response: CollectionMutationResponse = self
            .authorized_json(
                Method::PATCH,
                base_url,
                &format!(
                    "/api/desktop/collection/{}/notes",
                    percent_encoding::utf8_percent_encode(
                        card_id,
                        percent_encoding::NON_ALPHANUMERIC
                    )
                ),
                token,
                Some(json!({
                    "notes": notes,
                    "expectedRevision": expected_revision,
                    "mutationId": mutation_id,
                })),
                &[],
            )
            .await?;
        Ok(CollectionMutationResult {
            state: response.state,
            replayed: response.replayed,
        })
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
        expected_revision: u64,
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
            Some(merge_object(
                slot,
                "expectedRevision",
                json!(expected_revision),
            )?),
            &[],
        )
        .await
    }

    pub async fn swap_binder_slots(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
        expected_revision: u64,
        source: Value,
        target: Value,
    ) -> Result<Value> {
        self.authorized_json(
            Method::POST,
            base_url,
            &format!(
                "/api/desktop/binders/versions/{}/swap",
                percent_encoding::utf8_percent_encode(
                    version_id,
                    percent_encoding::NON_ALPHANUMERIC
                )
            ),
            token,
            Some(json!({
                "expectedRevision": expected_revision,
                "source": source,
                "target": target,
            })),
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
        let response = self.send_with_retry(request).await?;
        let status = response.status();
        if status != StatusCode::OK && status != StatusCode::PARTIAL_CONTENT {
            return Err(read_cloud_error(response).await);
        }
        let resume = start > 0 && status == StatusCode::PARTIAL_CONTENT;
        if resume {
            let expected = format!("bytes {start}-");
            let content_range = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    DesktopError::InvalidCloudResponse(
                        "partial response omitted Content-Range".to_string(),
                    )
                })?;
            if !content_range.starts_with(&expected) {
                return Err(DesktopError::InvalidCloudResponse(format!(
                    "partial response started at the wrong byte: {content_range}"
                )));
            }
        }
        let mut options = tokio::fs::OpenOptions::new();
        options.create(true).write(true);
        if resume {
            options.append(true);
        } else {
            options.truncate(true);
        }
        let mut file = options.open(destination).await?;
        let mut stream = response.bytes_stream();
        let maximum = entry.bytes.min(15 * 1024 * 1024);
        let mut written = if resume { start } else { 0 };
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            written = written.saturating_add(chunk.len() as u64);
            if written > maximum {
                return Err(DesktopError::InvalidCloudResponse(
                    "art response exceeded its manifest size".to_string(),
                ));
            }
            file.write_all(&chunk).await?;
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

    pub async fn issue_upload_tickets(
        &self,
        base_url: &str,
        token: &str,
        entries: &[ArtManifestEntry],
    ) -> Result<Vec<(ArtManifestEntry, UploadTicket)>> {
        if entries.is_empty() || entries.len() > 100 {
            return Err(DesktopError::InvalidCloudResponse(
                "bulk ticket request must contain 1 to 100 uploads".to_string(),
            ));
        }
        let response: BulkUploadTicketResponse = self
            .authorized_json(
                Method::POST,
                base_url,
                "/api/desktop/art/upload-tokens/bulk",
                token,
                Some(json!({
                    "uploads": entries.iter().map(|entry| json!({
                        "cardId": entry.card_id,
                        "variant": entry.variant,
                        "sha256": entry.sha256,
                        "maxBytes": entry.bytes,
                    })).collect::<Vec<_>>()
                })),
                &[],
            )
            .await?;
        if response.uploads.len() != entries.len() {
            return Err(DesktopError::InvalidCloudResponse(
                "bulk ticket response count did not match request".to_string(),
            ));
        }
        entries
            .iter()
            .cloned()
            .map(|entry| {
                let ticket = response
                    .uploads
                    .iter()
                    .find(|ticket| {
                        ticket.card_id == entry.card_id && ticket.variant == entry.variant
                    })
                    .ok_or_else(|| {
                        DesktopError::InvalidCloudResponse(
                            "bulk ticket response omitted an upload".to_string(),
                        )
                    })?;
                Ok((
                    entry,
                    UploadTicket {
                        token: ticket.token.clone(),
                        upload_path: ticket.upload_path.clone(),
                    },
                ))
            })
            .collect()
    }

    pub async fn upload_art_file(
        &self,
        base_url: &str,
        ticket: &UploadTicket,
        path: &Path,
        bytes: u64,
    ) -> Result<()> {
        if bytes == 0 || bytes > 15 * 1024 * 1024 {
            return Err(DesktopError::InvalidImage(
                "art upload size is outside the permitted range".to_string(),
            ));
        }
        let url = upload_url(base_url, &ticket.upload_path)?;
        for attempt in 0_u32..3 {
            let file = tokio::fs::File::open(path).await?;
            let result = self
                .http
                .put(url.clone())
                .header(reqwest::header::CONTENT_TYPE, "image/webp")
                .header(reqwest::header::CONTENT_LENGTH, bytes)
                .body(reqwest::Body::wrap_stream(ReaderStream::new(file)))
                .send()
                .await;
            match result {
                Ok(response) if response.status().is_success() => return Ok(()),
                Ok(response) if should_retry(response.status()) && attempt < 2 => {
                    let delay = retry_delay(&response, attempt);
                    response.bytes().await?;
                    tokio::time::sleep(delay).await;
                }
                Ok(response) => return Err(read_cloud_error(response).await),
                Err(error) if (error.is_timeout() || error.is_connect()) && attempt < 2 => {
                    tokio::time::sleep(exponential_delay(attempt)).await;
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(DesktopError::InvalidCloudResponse(
            "upload retries were exhausted".to_string(),
        ))
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

    async fn send_with_retry(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response> {
        for attempt in 0_u32..3 {
            let cloned = request.try_clone().ok_or_else(|| {
                DesktopError::InvalidCloudResponse("request body cannot be retried".to_string())
            })?;
            match cloned.send().await {
                Ok(response) if should_retry(response.status()) && attempt < 2 => {
                    let delay = retry_delay(&response, attempt);
                    response.bytes().await?;
                    tokio::time::sleep(delay).await;
                }
                Ok(response) => return Ok(response),
                Err(error) if (error.is_timeout() || error.is_connect()) && attempt < 2 => {
                    tokio::time::sleep(exponential_delay(attempt)).await;
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(DesktopError::InvalidCloudResponse(
            "request retries were exhausted".to_string(),
        ))
    }
}

fn api_url(base_url: &str, path: &str) -> Result<Url> {
    let mut base = Url::parse(base_url)?;
    base.set_path("/");
    base.set_query(None);
    base.set_fragment(None);
    Ok(base.join(path.trim_start_matches('/'))?)
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn upload_url(base_url: &str, path: &str) -> Result<Url> {
    if !path.starts_with('/') || path.starts_with("//") {
        return Err(DesktopError::InvalidCloudResponse(
            "upload path must be same-origin and absolute-path relative".to_string(),
        ));
    }
    let base = Url::parse(base_url)?;
    let upload = api_url(base_url, path)?;
    if !same_origin(&base, &upload) {
        return Err(DesktopError::InvalidCloudResponse(
            "upload path changed origin".to_string(),
        ));
    }
    Ok(upload)
}

fn merge_object(mut value: Value, key: &str, addition: Value) -> Result<Value> {
    let object = value.as_object_mut().ok_or_else(|| {
        DesktopError::InvalidCloudResponse("request payload must be an object".to_string())
    })?;
    object.insert(key.to_string(), addition);
    Ok(value)
}

fn should_retry(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn exponential_delay(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_millis(250 * 2_u64.pow(attempt))
}

fn retry_delay(response: &reqwest::Response, attempt: u32) -> std::time::Duration {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(std::time::Duration::from_secs)
        .unwrap_or_else(|| exponential_delay(attempt))
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
