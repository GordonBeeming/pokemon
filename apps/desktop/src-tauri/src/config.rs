use crate::error::{DesktopError, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use url::Url;

pub const DEFAULT_MCP_PORT: u16 = 47_837;

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub config_file: PathBuf,
    pub inbox_dir: PathBuf,
    pub mcp_token_file: PathBuf,
}

impl AppPaths {
    pub fn new(data_dir: PathBuf, config_dir: PathBuf) -> Self {
        Self {
            inbox_dir: data_dir.join("pending-scans"),
            mcp_token_file: data_dir.join("codex-mcp-token"),
            data_dir,
            config_file: config_dir.join("desktop.json"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub cloud_base_url: String,
    pub image_library_path: PathBuf,
    pub mcp_port: u16,
    pub device_label: String,
}

impl AppConfig {
    pub fn defaults(paths: &AppPaths) -> Self {
        Self {
            cloud_base_url: "https://pokedex.gordonbeeming.com".to_string(),
            image_library_path: paths.data_dir.join("card-art"),
            mcp_port: DEFAULT_MCP_PORT,
            device_label: "Home scanner".to_string(),
        }
    }

    pub fn validate(&self) -> Result<()> {
        validate_service_url(&self.cloud_base_url, "cloudBaseUrl")?;
        if !self.image_library_path.is_absolute() {
            return Err(DesktopError::InvalidConfig(
                "imageLibraryPath must be absolute".to_string(),
            ));
        }
        if self.mcp_port == 0 {
            return Err(DesktopError::InvalidConfig(
                "mcpPort must be between 1 and 65535".to_string(),
            ));
        }
        let label = self.device_label.trim();
        if label.is_empty() || label.len() > 80 {
            return Err(DesktopError::InvalidConfig(
                "deviceLabel must contain 1 to 80 characters".to_string(),
            ));
        }
        Ok(())
    }
}

fn validate_service_url(value: &str, field: &str) -> Result<()> {
    let url = Url::parse(value)
        .map_err(|error| DesktopError::InvalidConfig(format!("{field}: {error}")))?;
    let host = url.host_str().unwrap_or_default();
    let local = matches!(host, "127.0.0.1" | "localhost" | "::1");
    if url.scheme() != "https" && !(local && url.scheme() == "http") {
        return Err(DesktopError::InvalidConfig(format!(
            "{field} must use HTTPS, except for loopback development URLs"
        )));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(DesktopError::InvalidConfig(format!(
            "{field} cannot contain a query or fragment"
        )));
    }
    Ok(())
}

pub fn load_or_create(paths: &AppPaths) -> Result<AppConfig> {
    if paths.config_file.exists() {
        let config: AppConfig = serde_json::from_slice(&fs::read(&paths.config_file)?)?;
        config.validate()?;
        return Ok(config);
    }
    let config = AppConfig::defaults(paths);
    save(&paths.config_file, &config)?;
    Ok(config)
}

pub fn save(path: &Path, config: &AppConfig) -> Result<()> {
    config.validate()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    write_private(&temporary, &serde_json::to_vec_pretty(config)?)?;
    fs::rename(temporary, path)?;
    set_private_permissions(path)?;
    Ok(())
}

pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    set_private_permissions(path)?;
    Ok(())
}

pub fn set_private_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn defaults_keep_the_library_in_application_data() {
        let root = tempdir().expect("temp dir");
        let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
        let config = AppConfig::defaults(&paths);

        assert_eq!(config.image_library_path, paths.data_dir.join("card-art"));
        config.validate().expect("valid defaults");
    }

    #[test]
    fn remote_http_urls_are_rejected_but_loopback_is_allowed() {
        let root = tempdir().expect("temp dir");
        let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
        let mut config = AppConfig::defaults(&paths);
        config.cloud_base_url = "http://example.com".to_string();
        assert!(config.validate().is_err());

        config.cloud_base_url = "http://127.0.0.1:8787".to_string();
        config.validate().expect("loopback development URL");
    }

    #[test]
    fn saved_config_is_private() {
        let root = tempdir().expect("temp dir");
        let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
        let config = AppConfig::defaults(&paths);
        save(&paths.config_file, &config).expect("save config");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&paths.config_file)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn pairing_page_is_derived_instead_of_persisted() {
        let root = tempdir().expect("temp dir");
        let paths = AppPaths::new(root.path().join("data"), root.path().join("config"));
        let config = AppConfig::defaults(&paths);
        let serialized = serde_json::to_string(&config).expect("config JSON");
        assert!(!serialized.contains("pairingPageUrl"));

        let legacy = serialized.trim_end_matches('}').to_string()
            + ",\"pairingPageUrl\":\"https://old.example/settings/desktop\"}";
        let migrated: AppConfig = serde_json::from_str(&legacy).expect("legacy config");
        assert_eq!(migrated.cloud_base_url, config.cloud_base_url);
    }
}
