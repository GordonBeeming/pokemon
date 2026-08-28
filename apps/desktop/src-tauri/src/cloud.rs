use crate::error::{DesktopError, Result};
use futures_util::StreamExt;
use reqwest::{redirect, Method, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;
use url::Url;

#[derive(Debug, Clone)]
pub struct CloudClient {
    http: reqwest::Client,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum LanguageCode {
    #[serde(rename = "en")]
    En,
    #[serde(rename = "fr")]
    Fr,
    #[serde(rename = "es")]
    Es,
    #[serde(rename = "es-mx")]
    EsMx,
    #[serde(rename = "it")]
    It,
    #[serde(rename = "pt")]
    Pt,
    #[serde(rename = "pt-br")]
    PtBr,
    #[serde(rename = "pt-pt")]
    PtPt,
    #[serde(rename = "de")]
    De,
    #[serde(rename = "nl")]
    Nl,
    #[serde(rename = "pl")]
    Pl,
    #[serde(rename = "ru")]
    Ru,
    #[serde(rename = "ja")]
    Ja,
    #[serde(rename = "ko")]
    Ko,
    #[serde(rename = "zh-tw")]
    ZhTw,
    #[serde(rename = "id")]
    Id,
    #[serde(rename = "th")]
    Th,
    #[serde(rename = "zh-cn")]
    ZhCn,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CardCategory {
    Pokemon,
    Trainer,
    Energy,
    Special,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BinderStatus {
    Draft,
    Active,
    Archived,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum BinderLayoutKind {
    #[serde(rename = "2x2")]
    TwoByTwo,
    #[serde(rename = "3x3")]
    ThreeByThree,
    #[serde(rename = "4x3")]
    FourByThree,
    #[serde(rename = "top-loader")]
    TopLoader,
    #[serde(rename = "custom")]
    Custom,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct CurrencyCode(String);

impl<'de> Deserialize<'de> for CurrencyCode {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        if value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase()) {
            Ok(Self(value))
        } else {
            Err(serde::de::Error::custom(
                "currency must be three uppercase ASCII letters",
            ))
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct IsoDateTime(String);

impl<'de> Deserialize<'de> for IsoDateTime {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        time::OffsetDateTime::parse(&value, &time::format_description::well_known::Rfc3339)
            .map_err(serde::de::Error::custom)?;
        Ok(Self(value))
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct IsoDate(String);

impl<'de> Deserialize<'de> for IsoDate {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        time::Date::parse(
            &value,
            &time::macros::format_description!("[year]-[month]-[day]"),
        )
        .map_err(serde::de::Error::custom)?;
        Ok(Self(value))
    }
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
    pub updated_at: IsoDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionMutationResult {
    pub state: CollectionState,
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PriceBaseline {
    pub amount_aud: Option<f64>,
    pub native_amount: Option<f64>,
    pub native_currency: Option<CurrencyCode>,
    pub source: Option<String>,
    pub source_captured_at: Option<IsoDateTime>,
    pub fx_date: Option<IsoDate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueCardView {
    pub id: String,
    pub name: String,
    pub language: LanguageCode,
    pub category: CardCategory,
    pub set_id: String,
    pub set_name: String,
    pub number: String,
    pub image_low_url: Option<String>,
    pub collection: Option<CollectionState>,
    pub price: PriceBaseline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueSource {
    pub provider: String,
    pub source_id: String,
    pub updated_at: IsoDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueDetailView {
    pub id: String,
    pub name: String,
    pub language: LanguageCode,
    pub category: CardCategory,
    pub set_id: String,
    pub set_name: String,
    pub number: String,
    pub image_low_url: Option<String>,
    pub supertype: Option<String>,
    pub subtype: Option<String>,
    pub species: Option<String>,
    pub rarity: Option<String>,
    pub artist: Option<String>,
    pub image_high_url: Option<String>,
    pub source: CatalogueSource,
    pub notes: Option<String>,
    pub collection: Option<CollectionState>,
    pub price: PriceBaseline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueSearchResult {
    pub ok: bool,
    pub total: u64,
    pub cards: Vec<CatalogueCardView>,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CatalogueDetailResult {
    pub ok: bool,
    pub card: CatalogueDetailView,
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
    #[serde(default)]
    pub entry_kind: Option<BinderEntryKind>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub pokemon_number: Option<u32>,
    #[serde(default)]
    pub assigned_card_id: Option<String>,
    #[serde(default)]
    pub starts_new_page: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BinderEntryKind {
    Empty,
    Reserved,
    ExactCard,
    Pokemon,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderSuggestedSlot {
    pub page_id: String,
    pub page: u32,
    pub row: u32,
    pub column: u32,
    pub card_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderLayout {
    pub kind: BinderLayoutKind,
    pub rows: u32,
    pub columns: u32,
}

impl<'de> Deserialize<'de> for BinderLayout {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct WireLayout {
            kind: BinderLayoutKind,
            rows: u32,
            columns: u32,
        }
        let layout = WireLayout::deserialize(deserializer)?;
        let valid = match layout.kind {
            BinderLayoutKind::TwoByTwo | BinderLayoutKind::TopLoader => {
                layout.rows == 2 && layout.columns == 2
            }
            BinderLayoutKind::ThreeByThree => layout.rows == 3 && layout.columns == 3,
            BinderLayoutKind::FourByThree => layout.rows == 3 && layout.columns == 4,
            BinderLayoutKind::Custom => {
                (1..=20).contains(&layout.rows) && (1..=20).contains(&layout.columns)
            }
        };
        if !valid {
            return Err(serde::de::Error::custom(
                "binder layout dimensions do not match its kind",
            ));
        }
        Ok(Self {
            kind: layout.kind,
            rows: layout.rows,
            columns: layout.columns,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderPage {
    pub id: String,
    pub position: u32,
    pub slots: Vec<BinderSlot>,
    #[serde(default)]
    pub kind: Option<BinderPageKind>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BinderPageKind {
    Slots,
    Reserved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderVersionSummary {
    pub id: String,
    pub binder_id: String,
    pub version_number: u32,
    pub status: BinderStatus,
    pub layout: BinderLayout,
    pub revision: u64,
    pub page_count: u32,
    #[serde(default)]
    pub capacity: Option<u32>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderView {
    pub id: String,
    pub name: String,
    pub active_version_id: Option<String>,
    pub latest_version_id: Option<String>,
    pub updated_at: IsoDateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BinderListResult {
    pub ok: bool,
    pub binders: Vec<BinderView>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderMutationResult {
    pub version: BinderVersionSummary,
    pub pages: Vec<BinderPage>,
    #[serde(default)]
    pub anchor: Option<BinderAnchor>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderAnchor {
    pub page: u32,
    pub row: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BinderMutationEnvelope {
    pub ok: bool,
    pub binder: BinderMutationResult,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderGetResult {
    pub version: BinderVersionSummary,
    pub pages: Vec<BinderPage>,
    pub next_page: Option<u32>,
    pub shortages: Vec<BinderShortage>,
    pub next_offset: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderSuggestionResult {
    pub shortages: Vec<BinderShortage>,
    pub next_offset: Option<u32>,
    pub empty_slots: Vec<BinderSuggestedSlot>,
    #[serde(default)]
    pub assignment_candidates: Vec<BinderAssignmentCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinderAssignmentCandidate {
    pub card_id: String,
    pub name: String,
    pub set_name: String,
    pub number: String,
    pub language: LanguageCode,
    pub owned: u32,
    pub assigned: u32,
    pub available: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BinderAssignmentCandidatesResult {
    pub ok: bool,
    pub candidates: Vec<BinderAssignmentCandidate>,
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
#[serde(rename_all = "camelCase")]
struct BinderSuggestionResponse {
    shortages: Vec<BinderShortage>,
    next_offset: Option<u32>,
    empty_slots: Vec<BinderSuggestedSlot>,
    #[serde(default)]
    assignment_candidates: Vec<BinderAssignmentCandidate>,
}

#[derive(Debug, Deserialize)]
struct ApiFailure {
    error: String,
}

impl CloudClient {
    pub fn new() -> Result<Self> {
        Self::with_timeouts(
            Duration::from_secs(5),
            Duration::from_secs(30),
            Duration::from_secs(120),
        )
    }

    fn with_timeouts(connect: Duration, read: Duration, request: Duration) -> Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(connect)
            .read_timeout(read)
            .timeout(request)
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
    ) -> Result<CatalogueSearchResult> {
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

    pub async fn card(
        &self,
        base_url: &str,
        token: &str,
        card_id: &str,
    ) -> Result<CatalogueDetailResult> {
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

    pub async fn list_binders(&self, base_url: &str, token: &str) -> Result<BinderListResult> {
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

    pub async fn binder(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
    ) -> Result<BinderGetResult> {
        let encoded =
            percent_encoding::utf8_percent_encode(version_id, percent_encoding::NON_ALPHANUMERIC);
        let binder_path = format!("/api/desktop/binders/versions/{encoded}");
        let shortages_path = format!("{binder_path}/shortages");
        let binder_query = [("page", "0".to_string()), ("limit", "1".to_string())];
        let shortages_query = [("offset", "0".to_string()), ("limit", "100".to_string())];
        let binder_request = self.authorized_json::<BinderResponse>(
            Method::GET,
            base_url,
            &binder_path,
            token,
            None,
            &binder_query,
        );
        let shortages_request = self.authorized_json::<BinderShortagesResponse>(
            Method::GET,
            base_url,
            &shortages_path,
            token,
            None,
            &shortages_query,
        );
        let (binder, shortages) = tokio::try_join!(binder_request, shortages_request)?;
        Ok(BinderGetResult {
            version: binder.binder.version,
            pages: binder.binder.pages,
            next_page: binder.binder.next_page,
            shortages: shortages.shortages,
            next_offset: shortages.next_offset,
        })
    }

    pub async fn binder_suggestions(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
    ) -> Result<BinderSuggestionResult> {
        let response: BinderSuggestionResponse = self
            .authorized_json(
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
            .await?;
        Ok(BinderSuggestionResult {
            shortages: response.shortages,
            next_offset: response.next_offset,
            empty_slots: response.empty_slots,
            assignment_candidates: response.assignment_candidates,
        })
    }

    pub async fn binder_assignment_candidates(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
        location: Value,
    ) -> Result<BinderAssignmentCandidatesResult> {
        let page = location
            .get("page")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                DesktopError::InvalidCloudResponse("assignment location requires page".to_string())
            })?;
        let row = location.get("row").and_then(Value::as_u64).ok_or_else(|| {
            DesktopError::InvalidCloudResponse("assignment location requires row".to_string())
        })?;
        let column = location
            .get("column")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                DesktopError::InvalidCloudResponse(
                    "assignment location requires column".to_string(),
                )
            })?;
        self.authorized_json(
            Method::GET,
            base_url,
            &format!(
                "/api/desktop/binders/versions/{}/assignment-candidates",
                percent_encoding::utf8_percent_encode(
                    version_id,
                    percent_encoding::NON_ALPHANUMERIC
                )
            ),
            token,
            None,
            &[
                ("page", page.to_string()),
                ("row", row.to_string()),
                ("column", column.to_string()),
            ],
        )
        .await
    }

    pub async fn insert_binder_entries(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
        body: Value,
    ) -> Result<BinderMutationEnvelope> {
        self.binder_mutation(
            Method::POST,
            base_url,
            token,
            version_id,
            "/entries/insert",
            body,
        )
        .await
    }

    pub async fn remove_binder_entry(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
        body: Value,
    ) -> Result<BinderMutationEnvelope> {
        self.binder_mutation(
            Method::POST,
            base_url,
            token,
            version_id,
            "/entries/remove",
            body,
        )
        .await
    }

    pub async fn move_binder_entry(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
        body: Value,
    ) -> Result<BinderMutationEnvelope> {
        self.binder_mutation(
            Method::POST,
            base_url,
            token,
            version_id,
            "/entries/move",
            body,
        )
        .await
    }

    pub async fn assign_binder_entry(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
        body: Value,
    ) -> Result<BinderMutationEnvelope> {
        self.binder_mutation(
            Method::PUT,
            base_url,
            token,
            version_id,
            "/assignment",
            body,
        )
        .await
    }

    pub async fn set_binder_page_break(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
        body: Value,
    ) -> Result<BinderMutationEnvelope> {
        self.binder_mutation(
            Method::PUT,
            base_url,
            token,
            version_id,
            "/page-break",
            body,
        )
        .await
    }

    pub async fn reserve_binder_page(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
        body: Value,
    ) -> Result<BinderMutationEnvelope> {
        self.binder_mutation(
            Method::PUT,
            base_url,
            token,
            version_id,
            "/reserved-page",
            body,
        )
        .await
    }

    pub async fn resize_binder_capacity(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
        body: Value,
    ) -> Result<BinderMutationEnvelope> {
        self.binder_mutation(Method::PUT, base_url, token, version_id, "/capacity", body)
            .await
    }

    pub async fn insert_full_pokedex(
        &self,
        base_url: &str,
        token: &str,
        version_id: &str,
        body: Value,
    ) -> Result<BinderMutationEnvelope> {
        self.binder_mutation(
            Method::POST,
            base_url,
            token,
            version_id,
            "/full-pokedex",
            body,
        )
        .await
    }

    async fn binder_mutation(
        &self,
        method: Method,
        base_url: &str,
        token: &str,
        version_id: &str,
        suffix: &str,
        body: Value,
    ) -> Result<BinderMutationEnvelope> {
        self.authorized_json(
            method,
            base_url,
            &format!(
                "/api/desktop/binders/versions/{}{suffix}",
                percent_encoding::utf8_percent_encode(
                    version_id,
                    percent_encoding::NON_ALPHANUMERIC
                )
            ),
            token,
            Some(body),
            &[],
        )
        .await
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
    ) -> Result<BinderMutationEnvelope> {
        self.create_binder_with_capacity(base_url, token, name, layout, None)
            .await
    }

    pub async fn create_binder_with_capacity(
        &self,
        base_url: &str,
        token: &str,
        name: &str,
        layout: Value,
        capacity: Option<u32>,
    ) -> Result<BinderMutationEnvelope> {
        let mut body = json!({ "name": name, "layout": layout });
        if let Some(capacity) = capacity {
            body["capacity"] = json!(capacity);
        }
        self.authorized_json(
            Method::POST,
            base_url,
            "/api/desktop/binders",
            token,
            Some(body),
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
    ) -> Result<BinderMutationEnvelope> {
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
    ) -> Result<BinderMutationEnvelope> {
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
        let mut query = vec![("limit", "5000".to_string())];
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
        let mut query = vec![("limit", "5000".to_string())];
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
                drop(file);
                let _ = tokio::fs::remove_file(destination).await;
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
        let response: BulkUploadTicketResponse = match self
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
            .await
        {
            Ok(response) => response,
            Err(DesktopError::Cloud {
                status: 404 | 405, ..
            }) => {
                let mut fallback = Vec::with_capacity(entries.len());
                for entry in entries {
                    fallback.push((
                        entry.clone(),
                        self.issue_upload_ticket(base_url, token, entry).await?,
                    ));
                }
                return Ok(fallback);
            }
            Err(error) => return Err(error),
        };
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
                .bearer_auth(&ticket.token)
                .header(reqwest::header::CONTENT_TYPE, "image/webp")
                .header(reqwest::header::CONTENT_LENGTH, bytes)
                .body(reqwest::Body::wrap_stream(ReaderStream::new(file)))
                .send()
                .await;
            match result {
                Ok(response) if response.status().is_success() => return Ok(()),
                Ok(response) if response.status() == StatusCode::CONFLICT && attempt < 2 => {
                    let delay = retry_delay(&response, attempt);
                    let error = read_cloud_error(response).await;
                    if !matches!(
                        error,
                        DesktopError::Cloud { ref code, .. } if code == "art_upload_in_progress"
                    ) {
                        return Err(error);
                    }
                    tracing::warn!(
                        target: "pokedex.cloud",
                        operation = "art-upload",
                        attempt = attempt + 1,
                        status = StatusCode::CONFLICT.as_u16(),
                        delay_ms = delay.as_millis(),
                        "retrying in-progress art upload"
                    );
                    tokio::time::sleep(delay).await;
                }
                Ok(response) if should_retry(response.status()) && attempt < 2 => {
                    let delay = retry_delay(&response, attempt);
                    tracing::warn!(
                        target: "pokedex.cloud",
                        operation = "art-upload",
                        attempt = attempt + 1,
                        status = response.status().as_u16(),
                        delay_ms = delay.as_millis(),
                        "retrying transient cloud response"
                    );
                    response.bytes().await?;
                    tokio::time::sleep(delay).await;
                }
                Ok(response) => return Err(read_cloud_error(response).await),
                Err(error) if (error.is_timeout() || error.is_connect()) && attempt < 2 => {
                    let delay = exponential_delay(attempt);
                    tracing::warn!(
                        target: "pokedex.cloud",
                        operation = "art-upload",
                        attempt = attempt + 1,
                        error = %error,
                        delay_ms = delay.as_millis(),
                        "retrying failed cloud request"
                    );
                    tokio::time::sleep(delay).await;
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
                    tracing::warn!(
                        target: "pokedex.cloud",
                        operation = "art-download",
                        attempt = attempt + 1,
                        status = response.status().as_u16(),
                        delay_ms = delay.as_millis(),
                        "retrying transient cloud response"
                    );
                    response.bytes().await?;
                    tokio::time::sleep(delay).await;
                }
                Ok(response) => return Ok(response),
                Err(error) if (error.is_timeout() || error.is_connect()) && attempt < 2 => {
                    let delay = exponential_delay(attempt);
                    tracing::warn!(
                        target: "pokedex.cloud",
                        operation = "art-download",
                        attempt = attempt + 1,
                        error = %error,
                        delay_ms = delay.as_millis(),
                        "retrying failed cloud request"
                    );
                    tokio::time::sleep(delay).await;
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
    let base = 250_u64.saturating_mul(2_u64.saturating_pow(attempt));
    let mut random = [0_u8; 2];
    let jitter = if getrandom::fill(&mut random).is_ok() {
        u64::from(u16::from_le_bytes(random)) % 126
    } else {
        0
    };
    std::time::Duration::from_millis(base.saturating_add(jitter))
}

fn retry_delay(response: &reqwest::Response, attempt: u32) -> std::time::Duration {
    retry_delay_from_headers(response.headers(), attempt)
}

fn retry_delay_from_headers(
    headers: &reqwest::header::HeaderMap,
    attempt: u32,
) -> std::time::Duration {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|seconds| std::time::Duration::from_secs(seconds.min(30)))
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
    use axum::{
        body::Bytes,
        extract::{Path as AxumPath, State},
        http::{HeaderMap, StatusCode},
        response::{IntoResponse, Response},
        routing::{get, patch, post, put},
        Json, Router,
    };
    use std::sync::{Arc, Mutex};
    use tempfile::tempdir;

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

    async fn spawn(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("test server");
        });
        format!("http://{address}")
    }

    fn binder_mutation_value(revision: u64) -> Value {
        json!({
            "version": {
                "id": "version-1", "binderId": "binder-1", "versionNumber": 1,
                "status": "draft", "layout": { "kind": "3x3", "rows": 3, "columns": 3 },
                "revision": revision, "pageCount": 1
            },
            "pages": [{
                "id": "page-1", "position": 0,
                "slots": [{ "pageId": "page-1", "row": 0, "column": 0, "cardId": "card-1" }]
            }]
        })
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

    #[tokio::test]
    async fn request_timeout_bounds_a_stalled_response() {
        async fn stalled() -> Json<Value> {
            tokio::time::sleep(Duration::from_millis(200)).await;
            Json(json!({ "ok": true, "token": "late", "scopes": [] }))
        }
        let base = spawn(Router::new().route("/api/desktop/pair/redeem", post(stalled))).await;
        let client = CloudClient::with_timeouts(
            Duration::from_millis(20),
            Duration::from_millis(20),
            Duration::from_millis(40),
        )
        .expect("client");
        let error = client
            .redeem_pairing_code(&base, "code", "Scanner")
            .await
            .expect_err("request timeout");
        assert!(matches!(error, DesktopError::Http(ref value) if value.is_timeout()));
    }

    #[tokio::test]
    async fn bulk_ticket_404_falls_back_to_single_ticket_contract() {
        async fn ticket(Json(body): Json<Value>) -> Json<Value> {
            let card = body["cardId"].as_str().expect("card ID");
            let variant = body["variant"].as_str().expect("variant");
            Json(json!({
                "ok": true,
                "token": format!("{card}-{variant}"),
                "uploadPath": format!("/upload/{card}/{variant}")
            }))
        }
        let base = spawn(Router::new().route("/api/desktop/art/upload-tokens", post(ticket))).await;
        let entries = [ArtManifestEntry {
            card_id: "card-1".to_string(),
            variant: ArtVariant::High,
            sha256: "a".repeat(64),
            bytes: 128,
        }];
        let tickets = CloudClient::new()
            .expect("client")
            .issue_upload_tickets(&base, "desktop-token", &entries)
            .await
            .expect("fallback tickets");
        assert_eq!(tickets.len(), 1);
        assert_eq!(tickets[0].1.token, "card-1-high");
        assert_eq!(tickets[0].1.upload_path, "/upload/card-1/high");
    }

    #[tokio::test]
    async fn collection_and_binder_contracts_are_checked_at_the_request_boundary() {
        async fn increment(
            AxumPath(card_id): AxumPath<String>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            assert_eq!(body["delta"], 2);
            assert!(body["mutationId"].as_str().is_some());
            Json(json!({
                "ok": true,
                "state": { "cardId": card_id, "quantity": 2, "notes": null, "revision": 4,
                  "updatedAt": "2026-08-25T00:00:00Z" },
                "replayed": false
            }))
        }
        async fn shortages() -> Json<Value> {
            Json(json!({
                "ok": true,
                "shortages": [{ "cardId": "card-1", "required": 2, "owned": 1, "missing": 1 }],
                "nextOffset": null,
                "emptySlots": [{ "pageId": "page-1", "page": 4, "row": 0, "column": 0, "cardId": null }]
            }))
        }
        let base = spawn(
            Router::new()
                .route(
                    "/api/desktop/collection/{card_id}/increment",
                    post(increment),
                )
                .route(
                    "/api/desktop/binders/versions/{version_id}/suggest",
                    get(shortages),
                ),
        )
        .await;
        let client = CloudClient::new().expect("client");
        let collection = client
            .increment_collection(&base, "token", "card-1", 2, uuid::Uuid::new_v4())
            .await
            .expect("collection response");
        assert_eq!(collection.state.revision, 4);
        let suggestions = client
            .binder_suggestions(&base, "token", "version-1")
            .await
            .expect("binder suggestions");
        assert_eq!(suggestions.shortages[0].missing, 1);
        assert!(suggestions.next_offset.is_none());
        assert_eq!(suggestions.empty_slots.len(), 1);
        assert_eq!(suggestions.empty_slots[0].page, 4);
    }

    #[tokio::test]
    async fn collection_revision_and_binder_slot_contracts_are_sent_exactly() {
        async fn set_collection(
            AxumPath(card_id): AxumPath<String>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            assert_eq!(card_id, "card-1");
            assert_eq!(body["quantity"], 3);
            assert_eq!(body["notes"], "sleeved");
            assert_eq!(body["expectedRevision"], 7);
            assert!(body["mutationId"].as_str().is_some());
            Json(json!({
                "ok": true,
                "state": { "cardId": card_id, "quantity": 3, "notes": "sleeved", "revision": 8,
                  "updatedAt": "2026-08-25T00:00:00Z" },
                "replayed": false
            }))
        }
        async fn notes(Json(body): Json<Value>) -> Json<Value> {
            assert!(body["notes"].is_null());
            assert_eq!(body["expectedRevision"], 8);
            assert!(body["mutationId"].as_str().is_some());
            Json(json!({
                "ok": true,
                "state": { "cardId": "card-1", "quantity": 3, "notes": null, "revision": 9,
                  "updatedAt": "2026-08-25T00:00:00Z" },
                "replayed": false
            }))
        }
        async fn set_slot(Json(body): Json<Value>) -> Json<Value> {
            assert_eq!(body["expectedRevision"], 9);
            assert_eq!(body["page"], 1);
            assert_eq!(body["row"], 2);
            assert_eq!(body["column"], 0);
            assert_eq!(body["cardId"], "card-1");
            Json(json!({ "ok": true, "binder": binder_mutation_value(10) }))
        }
        async fn swap(Json(body): Json<Value>) -> Json<Value> {
            assert_eq!(body["expectedRevision"], 10);
            assert_eq!(body["source"]["column"], 0);
            assert_eq!(body["target"]["column"], 1);
            Json(json!({ "ok": true, "binder": binder_mutation_value(11) }))
        }
        let base = spawn(
            Router::new()
                .route("/api/desktop/collection/{card_id}", put(set_collection))
                .route("/api/desktop/collection/{card_id}/notes", patch(notes))
                .route(
                    "/api/desktop/binders/versions/{version_id}/slot",
                    put(set_slot),
                )
                .route(
                    "/api/desktop/binders/versions/{version_id}/swap",
                    post(swap),
                ),
        )
        .await;
        let client = CloudClient::new().expect("client");
        let mutation_id = uuid::Uuid::new_v4();
        let set = client
            .set_collection(
                &base,
                "token",
                CollectionSetInput {
                    card_id: "card-1",
                    quantity: 3,
                    notes: Some("sleeved"),
                    mutation_id,
                    expected_revision: 7,
                },
            )
            .await
            .expect("set collection");
        assert_eq!(set.state.revision, 8);
        let notes = client
            .patch_collection_notes(&base, "token", "card-1", None, 8, mutation_id)
            .await
            .expect("patch notes");
        assert_eq!(notes.state.revision, 9);
        client
            .set_binder_slot(
                &base,
                "token",
                "version-1",
                json!({ "page": 1, "row": 2, "column": 0, "cardId": "card-1" }),
                9,
            )
            .await
            .expect("set slot");
        client
            .swap_binder_slots(
                &base,
                "token",
                "version-1",
                10,
                json!({ "page": 1, "row": 2, "column": 0 }),
                json!({ "page": 1, "row": 2, "column": 1 }),
            )
            .await
            .expect("swap slots");
    }

    #[tokio::test]
    async fn bulk_tickets_are_mapped_by_card_and_variant_not_response_order() {
        async fn bulk() -> Json<Value> {
            Json(json!({
                "ok": true,
                "uploads": [
                    { "cardId": "card-2", "variant": "low", "token": "second", "uploadPath": "/upload/second" },
                    { "cardId": "card-1", "variant": "high", "token": "first", "uploadPath": "/upload/first" }
                ]
            }))
        }
        let base =
            spawn(Router::new().route("/api/desktop/art/upload-tokens/bulk", post(bulk))).await;
        let entries = [
            ArtManifestEntry {
                card_id: "card-1".to_string(),
                variant: ArtVariant::High,
                sha256: "a".repeat(64),
                bytes: 10,
            },
            ArtManifestEntry {
                card_id: "card-2".to_string(),
                variant: ArtVariant::Low,
                sha256: "b".repeat(64),
                bytes: 8,
            },
        ];
        let tickets = CloudClient::new()
            .expect("client")
            .issue_upload_tickets(&base, "token", &entries)
            .await
            .expect("bulk tickets");
        assert_eq!(tickets[0].1.token, "first");
        assert_eq!(tickets[1].1.token, "second");
    }

    #[tokio::test]
    async fn streamed_download_checks_content_range_and_removes_oversized_output() {
        async fn wrong_range(headers: HeaderMap) -> (StatusCode, HeaderMap, Bytes) {
            assert_eq!(
                headers
                    .get(reqwest::header::RANGE)
                    .and_then(|value| value.to_str().ok()),
                Some("bytes=4-")
            );
            let mut response_headers = HeaderMap::new();
            response_headers.insert(
                reqwest::header::CONTENT_RANGE,
                "bytes 3-6/7".parse().expect("content range"),
            );
            (
                StatusCode::PARTIAL_CONTENT,
                response_headers,
                Bytes::from_static(b"data"),
            )
        }
        async fn oversized() -> Bytes {
            Bytes::from_static(b"12345")
        }
        let base = spawn(
            Router::new()
                .route("/api/desktop/art/card1/high", get(wrong_range))
                .route("/api/desktop/art/card2/low", get(oversized)),
        )
        .await;
        let root = tempdir().expect("temp dir");
        let wrong_path = root.path().join("wrong.part");
        tokio::fs::write(&wrong_path, b"1234")
            .await
            .expect("partial file");
        let client = CloudClient::new().expect("client");
        let wrong = client
            .download_art_to(
                &base,
                "token",
                &ArtManifestEntry {
                    card_id: "card1".to_string(),
                    variant: ArtVariant::High,
                    sha256: "a".repeat(64),
                    bytes: 7,
                },
                4,
                &wrong_path,
            )
            .await
            .expect_err("wrong range");
        assert!(
            wrong.to_string().contains("wrong byte"),
            "unexpected error: {wrong}"
        );
        assert_eq!(
            tokio::fs::read(&wrong_path).await.expect("partial"),
            b"1234"
        );

        let oversized_path = root.path().join("oversized.part");
        let oversized = client
            .download_art_to(
                &base,
                "token",
                &ArtManifestEntry {
                    card_id: "card2".to_string(),
                    variant: ArtVariant::Low,
                    sha256: "b".repeat(64),
                    bytes: 4,
                },
                0,
                &oversized_path,
            )
            .await
            .expect_err("oversized stream");
        assert!(oversized.to_string().contains("manifest size"));
        assert!(!oversized_path.exists());
    }

    #[tokio::test]
    async fn upload_stream_preserves_same_origin_path_and_declared_length() {
        async fn upload(headers: HeaderMap, body: Bytes) -> Json<Value> {
            assert_eq!(
                headers
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok()),
                Some("image/webp")
            );
            assert_eq!(
                headers
                    .get(reqwest::header::CONTENT_LENGTH)
                    .and_then(|value| value.to_str().ok()),
                Some("12")
            );
            assert_eq!(body.as_ref(), b"RIFFxxxxWEBP");
            assert_eq!(
                headers
                    .get(reqwest::header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok()),
                Some("Bearer secret")
            );
            Json(json!({ "ok": true }))
        }
        let base =
            spawn(Router::new().route("/api/desktop/art/uploads/ticket-1", put(upload))).await;
        let root = tempdir().expect("temp dir");
        let path = root.path().join("art.webp");
        tokio::fs::write(&path, b"RIFFxxxxWEBP")
            .await
            .expect("art file");
        CloudClient::new()
            .expect("client")
            .upload_art_file(
                &base,
                &UploadTicket {
                    token: "secret".to_string(),
                    upload_path: "/api/desktop/art/uploads/ticket-1".to_string(),
                },
                &path,
                12,
            )
            .await
            .expect("stream upload");
        assert!(upload_url(&base, "https://attacker.example/upload").is_err());
        assert!(upload_url(&base, "//attacker.example/upload").is_err());
    }

    type RecordedUploads = Vec<(String, Vec<u8>)>;

    #[derive(Clone, Default)]
    struct UploadAttempts(Arc<Mutex<RecordedUploads>>);

    async fn ambiguous_upload(
        State(attempts): State<UploadAttempts>,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        let authorization = headers
            .get(reqwest::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let attempt = {
            let mut values = attempts.0.lock().expect("attempt lock");
            values.push((authorization, body.to_vec()));
            values.len()
        };
        if attempt == 1 {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": "upload_response_lost" })),
            )
                .into_response();
        }
        Json(json!({
            "ok": true, "cardId": "card-1", "variant": "high",
            "objectKey": "art/card-1/high.webp", "replayed": true
        }))
        .into_response()
    }

    #[tokio::test]
    async fn ambiguous_upload_retries_the_same_bearer_and_file_body() {
        let attempts = UploadAttempts::default();
        let base = spawn(
            Router::new()
                .route("/api/desktop/art/uploads/ticket-1", put(ambiguous_upload))
                .with_state(attempts.clone()),
        )
        .await;
        let root = tempdir().expect("temp dir");
        let path = root.path().join("art.webp");
        tokio::fs::write(&path, b"RIFFxxxxWEBP")
            .await
            .expect("art file");

        CloudClient::new()
            .expect("client")
            .upload_art_file(
                &base,
                &UploadTicket {
                    token: "same-secret".to_string(),
                    upload_path: "/api/desktop/art/uploads/ticket-1".to_string(),
                },
                &path,
                12,
            )
            .await
            .expect("replayed upload");

        let values = attempts.0.lock().expect("attempt lock");
        assert_eq!(values.len(), 2);
        assert!(values.iter().all(
            |(authorization, body)| authorization == "Bearer same-secret"
                && body == b"RIFFxxxxWEBP"
        ));
    }

    #[tokio::test]
    async fn terminal_invalid_upload_token_is_not_retried() {
        #[derive(Clone, Default)]
        struct Calls(Arc<Mutex<u32>>);
        async fn invalid(State(calls): State<Calls>) -> (StatusCode, Json<Value>) {
            *calls.0.lock().expect("calls lock") += 1;
            (
                StatusCode::CONFLICT,
                Json(json!({ "ok": false, "error": "art_upload_token_invalid" })),
            )
        }
        let calls = Calls::default();
        let base = spawn(
            Router::new()
                .route("/api/desktop/art/uploads/ticket-1", put(invalid))
                .with_state(calls.clone()),
        )
        .await;
        let root = tempdir().expect("temp dir");
        let path = root.path().join("art.webp");
        tokio::fs::write(&path, b"RIFFxxxxWEBP")
            .await
            .expect("art file");

        let error = CloudClient::new()
            .expect("client")
            .upload_art_file(
                &base,
                &UploadTicket {
                    token: "expired".to_string(),
                    upload_path: "/api/desktop/art/uploads/ticket-1".to_string(),
                },
                &path,
                12,
            )
            .await
            .expect_err("invalid token");

        assert!(
            matches!(error, DesktopError::Cloud { status: 409, ref code } if code == "art_upload_token_invalid")
        );
        assert_eq!(*calls.0.lock().expect("calls lock"), 1);
    }

    #[tokio::test]
    async fn in_progress_upload_honours_retry_after_and_replays_same_token() {
        #[derive(Clone, Default)]
        struct Calls(Arc<Mutex<Vec<String>>>);
        async fn upload(State(calls): State<Calls>, headers: HeaderMap) -> Response {
            let authorization = headers
                .get(reqwest::header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_string();
            let attempt = {
                let mut values = calls.0.lock().expect("calls lock");
                values.push(authorization);
                values.len()
            };
            if attempt == 1 {
                return (
                    StatusCode::CONFLICT,
                    [(reqwest::header::RETRY_AFTER, "0")],
                    Json(json!({ "ok": false, "error": "art_upload_in_progress" })),
                )
                    .into_response();
            }
            Json(json!({
                "ok": true, "cardId": "card-1", "variant": "high",
                "objectKey": "art/card-1/high.webp", "replayed": true
            }))
            .into_response()
        }
        let calls = Calls::default();
        let base = spawn(
            Router::new()
                .route("/api/desktop/art/uploads/ticket-1", put(upload))
                .with_state(calls.clone()),
        )
        .await;
        let root = tempdir().expect("temp dir");
        let path = root.path().join("art.webp");
        tokio::fs::write(&path, b"RIFFxxxxWEBP")
            .await
            .expect("art file");

        CloudClient::new()
            .expect("client")
            .upload_art_file(
                &base,
                &UploadTicket {
                    token: "same-secret".to_string(),
                    upload_path: "/api/desktop/art/uploads/ticket-1".to_string(),
                },
                &path,
                12,
            )
            .await
            .expect("replayed upload");

        assert_eq!(
            *calls.0.lock().expect("calls lock"),
            ["Bearer same-secret", "Bearer same-secret"]
        );
    }

    #[test]
    fn retry_delays_are_jittered_and_retry_after_is_capped() {
        for attempt in 0..3 {
            let delay = exponential_delay(attempt);
            let base = 250_u64 * 2_u64.pow(attempt);
            assert!(delay >= Duration::from_millis(base));
            assert!(delay <= Duration::from_millis(base + 125));
        }
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "300".parse().expect("header"));
        assert_eq!(
            retry_delay_from_headers(&headers, 0),
            Duration::from_secs(30)
        );
    }

    #[test]
    fn response_dtos_reject_unknown_enums_and_invalid_formatted_values() {
        let card = json!({
            "id": "card-1", "name": "Card", "language": "en", "category": "pokemon",
            "setId": "set-1", "setName": "Set", "number": "1", "imageLowUrl": null,
            "collection": null,
            "price": { "amountAud": null, "nativeAmount": 1.0, "nativeCurrency": "AUD",
              "source": "market", "sourceCapturedAt": "2026-08-25T00:00:00Z", "fxDate": "2026-08-25" }
        });
        let valid: CatalogueSearchResult = serde_json::from_value(json!({
            "ok": true, "total": 1, "cards": [card.clone()], "cursor": null
        }))
        .expect("valid catalogue response");
        assert_eq!(valid.cards[0].language, LanguageCode::En);
        assert_eq!(valid.cards[0].category, CardCategory::Pokemon);

        let mut invalid_category = card.clone();
        invalid_category["category"] = json!("pocket");
        assert!(serde_json::from_value::<CatalogueSearchResult>(json!({
            "ok": true, "total": 1, "cards": [invalid_category], "cursor": null
        }))
        .is_err());

        let mut invalid_currency = card.clone();
        invalid_currency["price"]["nativeCurrency"] = json!("aud");
        assert!(serde_json::from_value::<CatalogueSearchResult>(json!({
            "ok": true, "total": 1, "cards": [invalid_currency], "cursor": null
        }))
        .is_err());

        let mut invalid_datetime = card;
        invalid_datetime["price"]["sourceCapturedAt"] = json!("25 August 2026");
        assert!(serde_json::from_value::<CatalogueSearchResult>(json!({
            "ok": true, "total": 1, "cards": [invalid_datetime], "cursor": null
        }))
        .is_err());

        assert!(serde_json::from_value::<BinderVersionSummary>(json!({
            "id": "version-1", "binderId": "binder-1", "versionNumber": 1,
            "status": "deleted", "layout": { "kind": "3x3", "rows": 3, "columns": 3 },
            "revision": 1, "pageCount": 1
        }))
        .is_err());
        assert!(serde_json::from_value::<BinderVersionSummary>(json!({
            "id": "version-1", "binderId": "binder-1", "versionNumber": 1,
            "status": "draft", "layout": { "kind": "3x3", "rows": 2, "columns": 2 },
            "revision": 1, "pageCount": 1
        }))
        .is_err());
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
