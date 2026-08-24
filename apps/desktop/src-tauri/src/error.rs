use std::path::PathBuf;

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
    Cloud { status: u16, code: String },
    #[error("cloud response was invalid: {0}")]
    InvalidCloudResponse(String),
    #[error("art checksum mismatch for {card_id}/{variant}")]
    ChecksumMismatch { card_id: String, variant: String },
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
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
