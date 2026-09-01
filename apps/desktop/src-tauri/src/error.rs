use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudBinderCapacityDetails {
    pub current_capacity: u32,
    pub required_capacity: u32,
    pub additional_pockets: u32,
    pub page_increment: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudActiveAssignmentLocation {
    pub binder_id: String,
    pub version_id: String,
    pub page: u32,
    pub row: u32,
    pub column: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudActiveAssignmentsDetails {
    pub active_assignments: Vec<CloudActiveAssignmentLocation>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum CloudErrorDetails {
    BinderCapacity(CloudBinderCapacityDetails),
    ActiveAssignments(CloudActiveAssignmentsDetails),
}

#[derive(Debug, thiserror::Error)]
pub enum DesktopError {
    #[error("configuration is invalid: {0}")]
    InvalidConfig(String),
    #[error("path is outside the permitted local directory: {0}")]
    InvalidPath(PathBuf),
    #[error("unsupported or invalid image: {0}")]
    InvalidImage(String),
    #[error("the desktop is not paired")]
    NotPaired,
    #[error("operation cancelled")]
    Cancelled,
    #[error("cloud request failed with status {status}: {code}")]
    Cloud {
        status: u16,
        code: String,
        request_id: Option<String>,
        details: Option<CloudErrorDetails>,
    },
    #[error("cloud response was invalid: {0}")]
    InvalidCloudResponse(String),
    #[error("art checksum mismatch for {card_id}/{variant}")]
    ChecksumMismatch { card_id: String, variant: String },
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{operation} failed: {primary}; rollback cleanup failed: {cleanup}")]
    Rollback {
        operation: &'static str,
        primary: Box<DesktopError>,
        cleanup: String,
    },
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("URL error: {0}")]
    Url(#[from] url::ParseError),
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Keychain error: {0}")]
    Keychain(String),
    #[error("MCP error: {0}")]
    Mcp(String),
}

pub type Result<T> = std::result::Result<T, DesktopError>;
