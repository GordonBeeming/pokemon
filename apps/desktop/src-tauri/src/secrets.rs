use crate::config::{set_private_permissions, write_private};
use crate::error::{DesktopError, Result};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::{Arc, Mutex};

pub const KEYCHAIN_SERVICE: &str = "com.gordonbeeming.pokedex.scanner";
pub const KEYCHAIN_ACCOUNT_PREFIX: &str = "desktop-cloud-token";

pub trait DesktopTokenStore: Send + Sync {
    fn get(&self, origin: &str) -> Result<Option<String>>;
    fn set(&self, origin: &str, token: &str) -> Result<()>;
    fn delete(&self, origin: &str) -> Result<()>;
    fn compare_delete(&self, origin: &str, expected: &str) -> Result<bool>;
}

trait CredentialBackend: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>>;
    fn set(&self, account: &str, token: &str) -> Result<()>;
    fn delete(&self, account: &str) -> Result<bool>;
}

#[derive(Debug, Default)]
struct SystemCredentialBackend;

impl SystemCredentialBackend {
    fn entry(account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(KEYCHAIN_SERVICE, account)
            .map_err(|error| DesktopError::Keychain(error.to_string()))
    }
}

impl CredentialBackend for SystemCredentialBackend {
    fn get(&self, account: &str) -> Result<Option<String>> {
        match Self::entry(account)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(DesktopError::Keychain(error.to_string())),
        }
    }

    fn set(&self, account: &str, token: &str) -> Result<()> {
        Self::entry(account)?
            .set_password(token)
            .map_err(|error| DesktopError::Keychain(error.to_string()))
    }

    fn delete(&self, account: &str) -> Result<bool> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(error) => Err(DesktopError::Keychain(error.to_string())),
        }
    }
}

pub struct KeychainTokenStore {
    operations: Mutex<()>,
    backend: Arc<dyn CredentialBackend>,
}

impl std::fmt::Debug for KeychainTokenStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("KeychainTokenStore")
            .finish_non_exhaustive()
    }
}

impl Default for KeychainTokenStore {
    fn default() -> Self {
        Self {
            operations: Mutex::new(()),
            backend: Arc::new(SystemCredentialBackend),
        }
    }
}

fn keychain_account(origin: &str) -> String {
    let digest = hex::encode(Sha256::digest(origin.as_bytes()));
    format!("{KEYCHAIN_ACCOUNT_PREFIX}-{}", &digest[..24])
}

impl DesktopTokenStore for KeychainTokenStore {
    fn get(&self, origin: &str) -> Result<Option<String>> {
        let _guard = self
            .operations
            .lock()
            .map_err(|_| DesktopError::Keychain("token operation lock was poisoned".to_string()))?;
        self.backend.get(&keychain_account(origin))
    }

    fn set(&self, origin: &str, token: &str) -> Result<()> {
        if token.trim().is_empty() {
            return Err(DesktopError::Keychain(
                "refusing to store an empty token".to_string(),
            ));
        }
        let _guard = self
            .operations
            .lock()
            .map_err(|_| DesktopError::Keychain("token operation lock was poisoned".to_string()))?;
        self.backend.set(&keychain_account(origin), token)
    }

    fn delete(&self, origin: &str) -> Result<()> {
        let _guard = self
            .operations
            .lock()
            .map_err(|_| DesktopError::Keychain("token operation lock was poisoned".to_string()))?;
        self.backend.delete(&keychain_account(origin)).map(|_| ())
    }

    fn compare_delete(&self, origin: &str, expected: &str) -> Result<bool> {
        use subtle::ConstantTimeEq;

        let _guard = self
            .operations
            .lock()
            .map_err(|_| DesktopError::Keychain("token operation lock was poisoned".to_string()))?;
        let account = keychain_account(origin);
        let current = match self.backend.get(&account)? {
            Some(token) => token,
            None => return Ok(false),
        };
        if current.len() != expected.len()
            || !bool::from(current.as_bytes().ct_eq(expected.as_bytes()))
        {
            return Ok(false);
        }
        self.backend.delete(&account)
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
    getrandom::fill(&mut bytes).map_err(|error| {
        DesktopError::Keychain(format!("random token generation failed: {error}"))
    })?;
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    write_private(path, token.as_bytes())?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Condvar, MutexGuard};
    use tempfile::tempdir;

    #[derive(Default)]
    struct ControlledBackend {
        values: Mutex<HashMap<String, String>>,
        events: Mutex<Vec<&'static str>>,
        get_started: (Mutex<bool>, Condvar),
        release_get: (Mutex<bool>, Condvar),
    }

    impl ControlledBackend {
        fn lock<'a, T>(mutex: &'a Mutex<T>) -> Result<MutexGuard<'a, T>> {
            mutex
                .lock()
                .map_err(|_| DesktopError::Keychain("test lock was poisoned".to_string()))
        }

        fn wait_for_get(&self) {
            let (started, changed) = &self.get_started;
            let mut started = started.lock().expect("get-started lock");
            while !*started {
                started = changed.wait(started).expect("get-started wait");
            }
        }

        fn allow_get_to_finish(&self) {
            let (released, changed) = &self.release_get;
            *released.lock().expect("release lock") = true;
            changed.notify_all();
        }
    }

    impl CredentialBackend for ControlledBackend {
        fn get(&self, account: &str) -> Result<Option<String>> {
            Self::lock(&self.events)?.push("get");
            let current = Self::lock(&self.values)?.get(account).cloned();
            let (started, changed) = &self.get_started;
            *Self::lock(started)? = true;
            changed.notify_all();
            let (released, changed) = &self.release_get;
            let mut released = Self::lock(released)?;
            while !*released {
                released = changed.wait(released).map_err(|_| {
                    DesktopError::Keychain("test release lock was poisoned".to_string())
                })?;
            }
            Ok(current)
        }

        fn set(&self, account: &str, token: &str) -> Result<()> {
            Self::lock(&self.events)?.push("set");
            Self::lock(&self.values)?.insert(account.to_string(), token.to_string());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<bool> {
            Self::lock(&self.events)?.push("delete");
            Ok(Self::lock(&self.values)?.remove(account).is_some())
        }
    }

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

    #[test]
    fn cloud_tokens_are_namespaced_by_origin() {
        assert_ne!(
            keychain_account("https://one.example"),
            keychain_account("https://two.example")
        );
        assert_eq!(
            keychain_account("https://one.example"),
            keychain_account("https://one.example")
        );
    }

    #[test]
    fn compare_delete_and_replacement_are_serialized_as_one_keychain_operation() {
        let origin = "https://pokedex.example";
        let account = keychain_account(origin);
        let backend = Arc::new(ControlledBackend::default());
        backend
            .values
            .lock()
            .expect("values lock")
            .insert(account, "old".to_string());
        let store = Arc::new(KeychainTokenStore {
            operations: Mutex::new(()),
            backend: backend.clone(),
        });

        let deleting_store = store.clone();
        let deleting = std::thread::spawn(move || {
            deleting_store
                .compare_delete(origin, "old")
                .expect("compare delete")
        });
        backend.wait_for_get();

        let setting_store = store.clone();
        let setting = std::thread::spawn(move || {
            setting_store.set(origin, "new").expect("replacement token");
        });
        backend.allow_get_to_finish();

        assert!(deleting.join().expect("delete thread"));
        setting.join().expect("set thread");
        assert_eq!(
            store.get(origin).expect("stored token"),
            Some("new".to_string())
        );
        assert_eq!(
            *backend.events.lock().expect("events lock"),
            ["get", "delete", "set", "get"]
        );
    }
}
