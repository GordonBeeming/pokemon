use crate::config::write_private;
use crate::error::{DesktopError, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_CAPTURE_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CaptureSource {
    Camera,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingScan {
    pub id: Uuid,
    pub created_at: u64,
    pub source: CaptureSource,
    pub mime_type: String,
    pub bytes: u64,
    #[serde(default = "Uuid::new_v4")]
    pub mutation_id: Uuid,
    #[serde(default)]
    pub state: ScanState,
    #[serde(default)]
    pub confirmed_card_id: Option<String>,
    #[serde(default)]
    pub completed_result: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ScanState {
    #[default]
    Pending,
    Claimed,
    Completed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingScanImage {
    pub id: Uuid,
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Clone)]
pub struct PendingInbox {
    root: PathBuf,
}

impl PendingInbox {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn save(
        &self,
        bytes: &[u8],
        declared_mime: &str,
        source: CaptureSource,
    ) -> Result<PendingScan> {
        if bytes.is_empty() || bytes.len() > MAX_CAPTURE_BYTES {
            return Err(DesktopError::InvalidImage(format!(
                "capture must contain 1 to {MAX_CAPTURE_BYTES} bytes"
            )));
        }
        let mime_type = detect_image_mime(bytes).ok_or_else(|| {
            DesktopError::InvalidImage("expected JPEG, PNG, WebP, or HEIC data".to_string())
        })?;
        if normalize_mime(declared_mime) != mime_type {
            return Err(DesktopError::InvalidImage(format!(
                "declared MIME type {declared_mime} does not match {mime_type} data"
            )));
        }
        std::fs::create_dir_all(&self.root)?;
        let id = Uuid::new_v4();
        let image_path = self.image_path(id, mime_type);
        let metadata = PendingScan {
            id,
            created_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| DesktopError::InvalidImage(error.to_string()))?
                .as_secs(),
            source,
            mime_type: mime_type.to_string(),
            bytes: bytes.len() as u64,
            mutation_id: Uuid::new_v4(),
            state: ScanState::Pending,
            confirmed_card_id: None,
            completed_result: None,
        };
        write_private(&image_path, bytes)?;
        if let Err(error) = write_private(
            &self.metadata_path(id),
            &serde_json::to_vec_pretty(&metadata)?,
        ) {
            let _cleanup_result = std::fs::remove_file(image_path);
            return Err(error);
        }
        Ok(metadata)
    }

    pub fn list(&self) -> Result<Vec<PendingScan>> {
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        let mut scans = Vec::new();
        for entry in std::fs::read_dir(&self.root)? {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            match self.read_metadata_path(&path) {
                Ok(scan)
                    if self.image_path(scan.id, &scan.mime_type).is_file()
                        || scan.state == ScanState::Completed =>
                {
                    scans.push(scan);
                }
                Ok(_) => {
                    tracing::warn!(path = %path.display(), "pending scan image is missing");
                }
                Err(error) => {
                    let quarantine = path.with_extension("json.invalid");
                    if let Err(rename_error) = std::fs::rename(&path, &quarantine) {
                        tracing::warn!(
                            path = %path.display(),
                            error = %error,
                            rename_error = %rename_error,
                            "could not quarantine invalid pending scan metadata"
                        );
                    } else {
                        tracing::warn!(
                            path = %path.display(),
                            error = %error,
                            "quarantined invalid pending scan metadata"
                        );
                    }
                }
            }
        }
        scans.sort_by_key(|scan| (scan.created_at, scan.id));
        Ok(scans)
    }

    pub fn read_image(&self, id: Uuid) -> Result<PendingScanImage> {
        let scan = self.read_metadata(id)?;
        let bytes = std::fs::read(self.image_path(id, &scan.mime_type))?;
        Ok(PendingScanImage {
            id,
            mime_type: scan.mime_type,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }

    pub fn delete(&self, id: Uuid) -> Result<()> {
        let scan = self.read_metadata(id)?;
        remove_if_exists(&self.image_path(id, &scan.mime_type))?;
        remove_if_exists(&self.metadata_path(id))?;
        Ok(())
    }

    pub fn claim(&self, id: Uuid, card_id: &str) -> Result<PendingScan> {
        let mut scan = self.read_metadata(id)?;
        match scan.state {
            ScanState::Pending => {
                scan.state = ScanState::Claimed;
                scan.confirmed_card_id = Some(card_id.to_string());
                self.write_metadata(&scan)?;
            }
            ScanState::Claimed | ScanState::Completed => {
                if scan.confirmed_card_id.as_deref() != Some(card_id) {
                    return Err(DesktopError::Mcp(
                        "scan is already claimed for a different card".to_string(),
                    ));
                }
            }
        }
        Ok(scan)
    }

    pub fn complete(&self, id: Uuid, result: serde_json::Value) -> Result<PendingScan> {
        let mut scan = self.read_metadata(id)?;
        if scan.state != ScanState::Claimed {
            return Err(DesktopError::Mcp(
                "scan must be claimed before completion".to_string(),
            ));
        }
        scan.state = ScanState::Completed;
        scan.completed_result = Some(result);
        self.write_metadata(&scan)?;
        Ok(scan)
    }

    pub fn finish_completed(&self, id: Uuid) -> Result<()> {
        let scan = self.read_metadata(id)?;
        if scan.state != ScanState::Completed {
            return Err(DesktopError::Mcp("scan is not complete".to_string()));
        }
        remove_if_exists(&self.image_path(id, &scan.mime_type))?;
        remove_if_exists(&self.metadata_path(id))?;
        Ok(())
    }

    fn read_metadata(&self, id: Uuid) -> Result<PendingScan> {
        let path = self.metadata_path(id);
        if !path.is_file() {
            return Err(DesktopError::InvalidPath(path));
        }
        let scan = self.read_metadata_path(&path)?;
        if scan.id != id {
            return Err(DesktopError::InvalidImage(
                "scan metadata identifier does not match its file".to_string(),
            ));
        }
        Ok(scan)
    }

    fn read_metadata_path(&self, path: &Path) -> Result<PendingScan> {
        Ok(serde_json::from_slice(&std::fs::read(path)?)?)
    }

    fn write_metadata(&self, scan: &PendingScan) -> Result<()> {
        write_private(
            &self.metadata_path(scan.id),
            &serde_json::to_vec_pretty(scan)?,
        )
    }

    fn metadata_path(&self, id: Uuid) -> PathBuf {
        self.root.join(format!("{id}.json"))
    }

    fn image_path(&self, id: Uuid, mime_type: &str) -> PathBuf {
        self.root.join(format!("{id}.{}", extension(mime_type)))
    }
}

fn normalize_mime(value: &str) -> &str {
    match value.trim().to_ascii_lowercase().as_str() {
        "image/jpg" | "image/jpeg" => "image/jpeg",
        "image/png" => "image/png",
        "image/webp" => "image/webp",
        "image/heif" | "image/heic" => "image/heic",
        _ => "",
    }
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let brand = &bytes[8..12];
        if matches!(brand, b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1") {
            return Some("image/heic");
        }
    }
    None
}

fn extension(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/heic" => "heic",
        _ => "bin",
    }
}

fn remove_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn webp() -> Vec<u8> {
        b"RIFF\x04\x00\x00\x00WEBPdata".to_vec()
    }

    #[test]
    fn camera_and_file_captures_use_the_same_pending_inbox() {
        let root = tempdir().expect("temp dir");
        let inbox = PendingInbox::new(root.path().join("inbox"));
        let first = inbox
            .save(&webp(), "image/webp", CaptureSource::Camera)
            .expect("camera capture");
        let second = inbox
            .save(&webp(), "image/webp", CaptureSource::File)
            .expect("file capture");

        let scans = inbox.list().expect("list scans");
        assert_eq!(scans.len(), 2);
        assert_eq!(
            inbox.read_image(first.id).expect("image").data,
            "UklGRgQAAABXRUJQZGF0YQ=="
        );
        inbox.delete(second.id).expect("delete scan");
        assert_eq!(inbox.list().expect("list scans").len(), 1);
    }

    #[test]
    fn declared_type_must_match_magic_bytes() {
        let root = tempdir().expect("temp dir");
        let inbox = PendingInbox::new(root.path().join("inbox"));
        let error = inbox
            .save(&webp(), "image/png", CaptureSource::File)
            .expect_err("mismatched type");
        assert!(error.to_string().contains("does not match"));
    }

    #[test]
    fn uuid_identifiers_cannot_traverse_the_inbox() {
        assert!(Uuid::parse_str("../../outside").is_err());
    }

    #[test]
    fn malformed_metadata_is_quarantined_without_hiding_valid_scans() {
        let root = tempdir().expect("temp dir");
        let inbox = PendingInbox::new(root.path().join("inbox"));
        let valid = inbox
            .save(&webp(), "IMAGE/WEBP", CaptureSource::File)
            .expect("valid scan");
        std::fs::write(inbox.root.join("broken.json"), b"not json").expect("broken metadata");

        let scans = inbox.list().expect("list scans");
        assert_eq!(scans.len(), 1);
        assert_eq!(scans[0].id, valid.id);
        assert!(inbox.root.join("broken.json.invalid").is_file());
    }

    #[test]
    fn claim_and_completion_persist_one_mutation_identity() {
        let root = tempdir().expect("temp dir");
        let inbox = PendingInbox::new(root.path().join("inbox"));
        let scan = inbox
            .save(&webp(), "image/webp", CaptureSource::Camera)
            .expect("scan");
        let claimed = inbox.claim(scan.id, "card-1").expect("claim");
        assert_eq!(claimed.mutation_id, scan.mutation_id);
        assert_eq!(claimed.state, ScanState::Claimed);
        let completed = inbox
            .complete(scan.id, serde_json::json!({ "ok": true }))
            .expect("complete");
        assert_eq!(completed.mutation_id, scan.mutation_id);
        assert_eq!(completed.state, ScanState::Completed);
        assert_eq!(
            inbox
                .claim(scan.id, "card-1")
                .expect("resume")
                .completed_result,
            Some(serde_json::json!({ "ok": true }))
        );
    }
}
