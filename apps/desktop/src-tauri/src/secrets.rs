use crate::config::{set_private_permissions, write_private};
use crate::error::{DesktopError, Result};
use base64::Engine;
use rand::RngCore;
use std::path::Path;

pub const KEYCHAIN_SERVICE: &str = "com.gordonbeeming.pokedex.scanner";
pub const KEYCHAIN_ACCOUNT: &str = "desktop-cloud-token";

pub trait DesktopTokenStore: Send + Sync {
    fn get(&self) -> Result<Option<String>>;
    fn set(&self, token: &str) -> Result<()>;
    fn delete(&self) -> Result<()>;
}

#[derive(Debug, Default)]
pub struct KeychainTokenStore;

impl KeychainTokenStore {
    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
            .map_err(|error| DesktopError::Keychain(error.to_string()))
    }
}

impl DesktopTokenStore for KeychainTokenStore {
    fn get(&self) -> Result<Option<String>> {
        match self.entry()?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(DesktopError::Keychain(error.to_string())),
        }
    }

    fn set(&self, token: &str) -> Result<()> {
        if token.trim().is_empty() {
            return Err(DesktopError::Keychain(
                "refusing to store an empty token".to_string(),
            ));
        }
        self.entry()?
            .set_password(token)
            .map_err(|error| DesktopError::Keychain(error.to_string()))
    }

    fn delete(&self) -> Result<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(DesktopError::Keychain(error.to_string())),
        }
    }
}

pub fn load_or_create_mcp_token(path: &Path) -> Result<String> {
    if path.exists() {
        let token = std::fs::read_to_string(path)?.trim().to_string();
        if !token.is_empty() {
            set_private_permissions(path)?;
            return Ok(token);
        }
    }
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    write_private(path, token.as_bytes())?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn mcp_token_is_random_private_and_reused() {
        let root = tempdir().expect("temp dir");
        let path = root.path().join("nested/token");
        let first = load_or_create_mcp_token(&path).expect("first token");
        let second = load_or_create_mcp_token(&path).expect("second token");

        assert_eq!(first, second);
        assert!(first.len() >= 40);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }
}
