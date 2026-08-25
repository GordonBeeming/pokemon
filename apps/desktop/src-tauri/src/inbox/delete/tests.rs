use super::*;
use crate::inbox::{CaptureSource, PendingInbox};
use tempfile::tempdir;

fn webp() -> Vec<u8> {
    b"RIFF\x04\x00\x00\x00WEBPdata".to_vec()
}

fn preview() -> Vec<u8> {
    b"\xff\xd8\xffpreview".to_vec()
}

#[test]
fn delete_rolls_back_every_staged_file_when_a_later_rename_fails() {
    for failed_stage in 1..=3 {
        let root = tempdir().expect("temp dir");
        let inbox = PendingInbox::new(root.path().join("inbox"));
        let scan = inbox
            .save(&webp(), &preview(), "image/webp", CaptureSource::File)
            .expect("scan");
        let mut stage = 0;
        let _lock = inbox.acquire_delete_lock().expect("delete lock");

        let error = inbox
            .delete_scan_locked_with(
                &scan,
                |source, tombstone| {
                    stage += 1;
                    if stage == failed_stage {
                        return Err(std::io::Error::other(format!(
                            "injected stage {failed_stage} failure"
                        )));
                    }
                    std::fs::rename(source, tombstone)
                },
                |tombstone| std::fs::remove_file(tombstone),
            )
            .expect_err("staging failure");

        assert!(error.to_string().contains(&format!("stage {failed_stage}")));
        assert!(inbox.image_path(scan.id, &scan.mime_type).is_file());
        assert!(inbox.thumbnail_path(scan.id).is_file());
        assert!(inbox.metadata_path(scan.id).is_file());
        assert_eq!(inbox.list().expect("list after rollback"), vec![scan]);
        assert_eq!(
            inbox
                .recover_delete_journals()
                .expect("no journals")
                .recovered,
            0
        );
    }
}

#[test]
fn startup_finishes_cleanup_for_a_committed_delete() {
    let root = tempdir().expect("temp dir");
    let inbox_root = root.path().join("inbox");
    let inbox = PendingInbox::new(inbox_root.clone());
    let scan = inbox
        .save(&webp(), &preview(), "image/webp", CaptureSource::Camera)
        .expect("scan");
    let mut cleanup = 0;
    let delete_lock = inbox.acquire_delete_lock().expect("delete lock");

    inbox
        .delete_scan_locked_with(
            &scan,
            |source, tombstone| std::fs::rename(source, tombstone),
            |tombstone| {
                cleanup += 1;
                if cleanup == 1 {
                    Err(std::io::Error::other("injected cleanup failure"))
                } else {
                    std::fs::remove_file(tombstone)
                }
            },
        )
        .expect("logical deletion succeeds");
    drop(delete_lock);

    assert!(inbox.list().expect("scan is logically gone").is_empty());
    assert_eq!(
        std::fs::read_dir(&inbox_root)
            .expect("inbox")
            .filter_map(|entry| entry.ok())
            .filter(|entry| { entry.file_name().to_string_lossy().ends_with(".tombstone") })
            .count(),
        1
    );
    let restarted = PendingInbox::new(inbox_root);
    assert_eq!(
        restarted
            .recover_delete_journals()
            .expect("clean restart")
            .recovered,
        0
    );
}

#[test]
fn startup_rolls_back_a_pending_delete_after_every_rename_boundary() {
    for moved in 1..=3 {
        let root = tempdir().expect("temp dir");
        let inbox_root = root.path().join("inbox");
        let inbox = PendingInbox::new(inbox_root.clone());
        let scan = inbox
            .save(&webp(), &preview(), "image/webp", CaptureSource::File)
            .expect("scan");
        let delete_lock = inbox.acquire_delete_lock().expect("delete lock");
        let journal = inbox.new_delete_journal(&scan).expect("journal");
        inbox
            .write_delete_journal(&journal)
            .expect("pending journal");
        for entry in journal.entries.iter().take(moved) {
            let (original, tombstone) = inbox.delete_entry_paths(entry).expect("paths");
            std::fs::rename(original, tombstone).expect("stage rename");
            sync_directory(&inbox.root).expect("durable rename");
        }
        drop(delete_lock);

        let restarted = PendingInbox::new(inbox_root);
        assert!(restarted.image_path(scan.id, &scan.mime_type).is_file());
        assert!(restarted.thumbnail_path(scan.id).is_file());
        assert!(restarted.metadata_path(scan.id).is_file());
        assert_eq!(restarted.list().expect("restored scan"), vec![scan]);
        assert_eq!(
            restarted
                .recover_delete_journals()
                .expect("no journal")
                .recovered,
            0
        );
    }
}

#[test]
fn startup_finalizes_a_committed_journal_after_a_crash() {
    let root = tempdir().expect("temp dir");
    let inbox_root = root.path().join("inbox");
    let inbox = PendingInbox::new(inbox_root.clone());
    let scan = inbox
        .save(&webp(), &preview(), "image/webp", CaptureSource::Camera)
        .expect("scan");
    let delete_lock = inbox.acquire_delete_lock().expect("delete lock");
    let mut journal = inbox.new_delete_journal(&scan).expect("journal");
    inbox
        .write_delete_journal(&journal)
        .expect("pending journal");
    for entry in &journal.entries {
        let (original, tombstone) = inbox.delete_entry_paths(entry).expect("paths");
        std::fs::rename(original, tombstone).expect("stage rename");
    }
    sync_directory(&inbox.root).expect("durable staging");
    journal.state = DeleteJournalState::Committed;
    inbox
        .write_delete_journal(&journal)
        .expect("committed journal");
    drop(delete_lock);

    let restarted = PendingInbox::new(inbox_root);
    assert!(restarted.list().expect("deleted scan").is_empty());
    assert!(!restarted.image_path(scan.id, &scan.mime_type).exists());
    assert!(!restarted.thumbnail_path(scan.id).exists());
    assert!(!restarted.metadata_path(scan.id).exists());
    assert_eq!(
        restarted
            .recover_delete_journals()
            .expect("no journal")
            .recovered,
        0
    );
}

#[test]
fn mixed_recovery_isolates_bad_journals_and_completes_safe_work() {
    let root = tempdir().expect("temp dir");
    let inbox_root = root.path().join("inbox");
    let inbox = PendingInbox::new(inbox_root.clone());
    let valid_temp_scan = inbox
        .save(&webp(), &preview(), "image/webp", CaptureSource::File)
        .expect("valid temp scan");
    let pending_scan = inbox
        .save(&webp(), &preview(), "image/webp", CaptureSource::Camera)
        .expect("pending scan");
    let committed_scan = inbox
        .save(&webp(), &preview(), "image/webp", CaptureSource::File)
        .expect("committed scan");
    let delete_lock = inbox.acquire_delete_lock().expect("delete lock");

    let malformed_final_id = Uuid::new_v4();
    let malformed_final = inbox.delete_journal_path(malformed_final_id);
    write_private(&malformed_final, b"not a journal").expect("malformed final");
    let malformed_final_tombstone = inbox.root.join(format!(
        "{DELETE_TOMBSTONE_PREFIX}{malformed_final_id}-unknown-capture.tombstone"
    ));
    write_private(&malformed_final_tombstone, b"preserve me").expect("final tombstone");

    let malformed_temp_id = Uuid::new_v4();
    let malformed_temp = inbox
        .delete_journal_path(malformed_temp_id)
        .with_extension("json.tmp");
    write_private(&malformed_temp, b"not a temporary journal").expect("malformed temp");
    let malformed_temp_tombstone = inbox.root.join(format!(
        "{DELETE_TOMBSTONE_PREFIX}{malformed_temp_id}-unknown-preview.tombstone"
    ));
    write_private(&malformed_temp_tombstone, b"preserve me too").expect("temp tombstone");

    let valid_temp = inbox
        .new_delete_journal(&valid_temp_scan)
        .expect("valid temporary journal");
    write_private(
        &inbox
            .delete_journal_path(valid_temp.operation_id)
            .with_extension("json.tmp"),
        &serde_json::to_vec_pretty(&valid_temp).expect("valid temp JSON"),
    )
    .expect("valid temp file");

    let pending = inbox
        .new_delete_journal(&pending_scan)
        .expect("pending journal");
    inbox.write_delete_journal(&pending).expect("pending final");
    let (pending_original, pending_tombstone) = inbox
        .delete_entry_paths(&pending.entries[0])
        .expect("pending paths");
    std::fs::rename(pending_original, pending_tombstone).expect("pending stage");

    let mut committed = inbox
        .new_delete_journal(&committed_scan)
        .expect("committed journal");
    inbox
        .write_delete_journal(&committed)
        .expect("committed pending state");
    for entry in &committed.entries {
        let (original, tombstone) = inbox.delete_entry_paths(entry).expect("committed paths");
        std::fs::rename(original, tombstone).expect("committed staging");
    }
    committed.state = DeleteJournalState::Committed;
    inbox
        .write_delete_journal(&committed)
        .expect("committed final state");
    sync_directory(&inbox.root).expect("durable mixed fixtures");

    let report = inbox.recover_delete_journals().expect("mixed recovery");
    drop(delete_lock);

    assert_eq!(report.promoted, 1);
    assert_eq!(report.recovered, 3);
    assert_eq!(report.quarantined, 2);
    assert_eq!(report.deferred, 0);
    assert!(report.diagnostics.len() >= 2);
    let recovered_scans = inbox.list().expect("safe scans recovered");
    assert_eq!(recovered_scans.len(), 2);
    assert!(recovered_scans
        .iter()
        .any(|scan| scan.id == valid_temp_scan.id));
    assert!(recovered_scans
        .iter()
        .any(|scan| scan.id == pending_scan.id));
    assert!(!inbox.metadata_path(committed_scan.id).exists());
    assert!(malformed_final_tombstone.is_file());
    assert!(malformed_temp_tombstone.is_file());
    assert_eq!(
        std::fs::read_dir(&inbox_root)
            .expect("inbox")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".invalid-"))
            .count(),
        2
    );
}

#[test]
fn canonical_validation_rejects_duplicate_unknown_missing_and_cross_scan_entries() {
    let root = tempdir().expect("temp dir");
    let inbox = PendingInbox::new(root.path().join("inbox"));
    let scan = inbox
        .save(&webp(), &preview(), "image/webp", CaptureSource::File)
        .expect("scan");
    let journal = inbox.new_delete_journal(&scan).expect("journal");

    let mut duplicate = journal.clone();
    duplicate.entries.push(duplicate.entries[0].clone());
    assert!(inbox
        .validate_delete_journal(&duplicate)
        .expect_err("duplicate label")
        .to_string()
        .contains("duplicate file label"));

    let mut unknown = journal.clone();
    unknown.entries[0].label = "sidecar".to_string();
    assert!(inbox
        .validate_delete_journal(&unknown)
        .expect_err("unknown label")
        .to_string()
        .contains("unknown file label"));

    let mut missing = journal.clone();
    missing.entries.retain(|entry| entry.label != "preview");
    assert!(inbox
        .validate_delete_journal(&missing)
        .expect_err("missing required label")
        .to_string()
        .contains("required file set"));

    let mut cross_scan = journal;
    let metadata = cross_scan
        .entries
        .iter_mut()
        .find(|entry| entry.label == "metadata")
        .expect("metadata entry");
    metadata.original = format!("{}.json", Uuid::new_v4());
    assert!(inbox
        .validate_delete_journal(&cross_scan)
        .expect_err("cross-scan original")
        .to_string()
        .contains("does not belong to its scan"));

    for (mime_type, wrong_extension) in [
        ("image/jpeg", "png"),
        ("image/png", "webp"),
        ("image/webp", "heic"),
        ("image/heic", "jpg"),
    ] {
        let mut mismatch = inbox.new_delete_journal(&scan).expect("journal");
        mismatch.capture_mime_type = mime_type.to_string();
        mismatch.capture_original = format!("{}.{}", scan.id, wrong_extension);
        mismatch
            .entries
            .iter_mut()
            .find(|entry| entry.label == "capture")
            .expect("capture entry")
            .original = mismatch.capture_original.clone();
        assert!(inbox
            .validate_delete_journal(&mismatch)
            .expect_err("same-scan extension mismatch")
            .to_string()
            .contains("capture identity"));
    }
}

#[test]
fn recovery_quarantines_a_self_consistent_capture_identity_that_disagrees_with_metadata() {
    let root = tempdir().expect("temp dir");
    let inbox = PendingInbox::new(root.path().join("inbox"));
    let scan = inbox
        .save(&webp(), &preview(), "image/webp", CaptureSource::File)
        .expect("scan");
    let mut journal = inbox.new_delete_journal(&scan).expect("journal");
    let false_capture = inbox.root.join(format!("{}.png", scan.id));
    std::fs::rename(inbox.image_path(scan.id, &scan.mime_type), &false_capture)
        .expect("rename capture to false identity");
    journal.capture_mime_type = "image/png".to_string();
    journal.capture_original = format!("{}.png", scan.id);
    journal
        .entries
        .iter_mut()
        .find(|entry| entry.label == "capture")
        .expect("capture entry")
        .original = journal.capture_original.clone();
    inbox
        .validate_delete_journal(&journal)
        .expect("journal is internally canonical");
    inbox.write_delete_journal(&journal).expect("false journal");

    let report = inbox.recover_delete_journals().expect("isolated recovery");

    assert_eq!(report.recovered, 0);
    assert_eq!(report.quarantined, 1);
    assert!(report.diagnostics.iter().any(
        |diagnostic| diagnostic.contains("capture identity disagrees with persisted metadata")
    ));
    assert!(false_capture.is_file());
    assert!(inbox.metadata_path(scan.id).is_file());
    assert!(inbox.thumbnail_path(scan.id).is_file());
    assert!(journal.entries.iter().all(|entry| {
        !inbox
            .delete_entry_paths(entry)
            .expect("entry paths")
            .1
            .exists()
    }));
}

#[test]
fn directory_entry_errors_are_reported_without_hiding_later_journals() {
    let root = tempdir().expect("temp dir");
    let first = root
        .path()
        .join(format!("{DELETE_TOMBSTONE_PREFIX}a.journal.json"));
    let later = root
        .path()
        .join(format!("{DELETE_TOMBSTONE_PREFIX}b.journal.json"));
    let unrelated = root.path().join("capture.webp");
    let mut report = DeleteRecoveryReport::default();

    let paths = collect_delete_journal_paths(
        vec![
            Ok(first.clone()),
            Err(std::io::Error::other("injected entry failure")),
            Ok(unrelated),
            Ok(later.clone()),
        ],
        ".journal.json",
        &mut report,
    );

    assert_eq!(paths, vec![first, later]);
    assert_eq!(report.deferred, 1);
    assert_eq!(report.diagnostics.len(), 1);
    assert!(report.diagnostics[0].contains("injected entry failure"));
}

#[test]
fn journal_creation_fails_before_staging_when_a_required_source_is_missing() {
    let root = tempdir().expect("temp dir");
    let inbox = PendingInbox::new(root.path().join("inbox"));
    let scan = inbox
        .save(&webp(), &preview(), "image/webp", CaptureSource::File)
        .expect("scan");
    std::fs::remove_file(inbox.thumbnail_path(scan.id)).expect("remove preview fixture");

    let error = inbox
        .new_delete_journal(&scan)
        .expect_err("missing preview must fail before journaling");

    assert!(error.to_string().contains("required preview file"));
    assert!(inbox.image_path(scan.id, &scan.mime_type).is_file());
    assert!(inbox.metadata_path(scan.id).is_file());
    assert_eq!(
        std::fs::read_dir(&inbox.root)
            .expect("inbox")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name.contains(".journal") || name.ends_with(".tombstone")
            })
            .count(),
        0
    );
}

#[test]
fn user_delete_rejects_claimed_and_completed_scans_while_finalize_removes_completed() {
    let root = tempdir().expect("temp dir");
    let inbox = PendingInbox::new(root.path().join("inbox"));
    let scan = inbox
        .save(&webp(), &preview(), "image/webp", CaptureSource::Camera)
        .expect("scan");

    inbox.claim(scan.id, "card-1").expect("claim scan");
    assert!(inbox
        .delete(scan.id)
        .expect_err("claimed delete is rejected")
        .to_string()
        .contains("cannot delete a claimed or completed scan"));
    inbox
        .complete(scan.id, serde_json::json!({ "ok": true }))
        .expect("complete scan");
    assert!(inbox
        .delete(scan.id)
        .expect_err("completed delete is rejected")
        .to_string()
        .contains("cannot delete a claimed or completed scan"));

    inbox
        .finish_completed(scan.id)
        .expect("finalization removes completed scan");
    assert!(inbox.list().expect("empty inbox").is_empty());
}

#[test]
fn committed_temporary_journal_supersedes_pending_final_after_crash() {
    let root = tempdir().expect("temp dir");
    let inbox = PendingInbox::new(root.path().join("inbox"));
    let scan = inbox
        .save(&webp(), &preview(), "image/webp", CaptureSource::Camera)
        .expect("scan");
    let _lock = inbox.acquire_delete_lock().expect("delete lock");
    let pending = inbox.new_delete_journal(&scan).expect("pending journal");
    inbox
        .write_delete_journal(&pending)
        .expect("pending final journal");
    for entry in &pending.entries {
        let (original, tombstone) = inbox.delete_entry_paths(entry).expect("entry paths");
        std::fs::rename(original, tombstone).expect("stage delete");
    }
    sync_directory(&inbox.root).expect("durable staging");

    let mut committed = pending.clone();
    committed.state = DeleteJournalState::Committed;
    let temporary = inbox
        .delete_journal_path(committed.operation_id)
        .with_extension("json.tmp");
    write_private(
        &temporary,
        &serde_json::to_vec_pretty(&committed).expect("committed JSON"),
    )
    .expect("committed temporary journal");
    sync_directory(&inbox.root).expect("durable committed temp");

    let report = inbox.recover_delete_journals().expect("recovery");
    assert_eq!(report.promoted, 1);
    assert_eq!(report.recovered, 1);
    assert_eq!(report.quarantined, 0);
    assert_eq!(report.deferred, 0);
    assert!(!inbox.metadata_path(scan.id).exists());
    assert!(!inbox.delete_journal_path(committed.operation_id).exists());
    assert!(!temporary.exists());
    for entry in &committed.entries {
        let (_, tombstone) = inbox.delete_entry_paths(entry).expect("entry paths");
        assert!(!tombstone.exists());
    }
}

#[test]
fn delete_lock_holder() {
    let Ok(root) = std::env::var("POKEDEX_TEST_DELETE_LOCK_ROOT") else {
        return;
    };
    let ready =
        PathBuf::from(std::env::var("POKEDEX_TEST_DELETE_LOCK_READY").expect("ready marker"));
    let release =
        PathBuf::from(std::env::var("POKEDEX_TEST_DELETE_LOCK_RELEASE").expect("release marker"));
    std::fs::create_dir_all(&root).expect("inbox root");
    let connection =
        rusqlite::Connection::open(Path::new(&root).join(DELETE_LOCK_DATABASE)).expect("lock DB");
    connection
        .execute_batch("BEGIN EXCLUSIVE")
        .expect("exclusive lock");
    std::fs::write(&ready, b"ready").expect("ready marker");
    while !release.exists() {
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn second_process_cannot_scavenge_an_inflight_delete() {
    let temp = tempdir().expect("temp dir");
    let inbox_root = temp.path().join("inbox");
    let inbox = PendingInbox::new(inbox_root.clone());
    let scan = inbox
        .save(&webp(), &preview(), "image/webp", CaptureSource::File)
        .expect("scan");
    let delete_lock = inbox.acquire_delete_lock().expect("delete lock");
    let journal = inbox.new_delete_journal(&scan).expect("journal");
    inbox
        .write_delete_journal(&journal)
        .expect("pending journal");
    let (capture, capture_tombstone) = inbox
        .delete_entry_paths(&journal.entries[0])
        .expect("capture paths");
    std::fs::rename(&capture, &capture_tombstone).expect("first staging rename");
    sync_directory(&inbox.root).expect("durable rename");
    drop(delete_lock);

    let ready = temp.path().join("ready");
    let release = temp.path().join("release");
    let mut child = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .arg("--exact")
        .arg("inbox::delete::tests::delete_lock_holder")
        .arg("--nocapture")
        .env("POKEDEX_TEST_DELETE_LOCK_ROOT", &inbox_root)
        .env("POKEDEX_TEST_DELETE_LOCK_READY", &ready)
        .env("POKEDEX_TEST_DELETE_LOCK_RELEASE", &release)
        .spawn()
        .expect("lock-holder process");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !ready.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(ready.exists(), "lock holder became ready");

    let _second_process = PendingInbox::new(inbox_root.clone());
    assert!(!capture.exists());
    assert!(capture_tombstone.exists());
    assert!(inbox.delete_journal_path(journal.operation_id).is_file());

    std::fs::write(&release, b"release").expect("release marker");
    assert!(child.wait().expect("child exit").success());
    let recovered = PendingInbox::new(inbox_root);
    assert!(recovered.image_path(scan.id, &scan.mime_type).is_file());
    assert_eq!(recovered.list().expect("restored scan"), vec![scan]);
}

#[test]
fn delete_waits_for_a_short_cross_process_journal_lease() {
    let temp = tempdir().expect("temp dir");
    let inbox_root = temp.path().join("inbox");
    let inbox = PendingInbox::new(inbox_root.clone());
    let scan = inbox
        .save(&webp(), &preview(), "image/webp", CaptureSource::File)
        .expect("scan");
    let ready = temp.path().join("ready");
    let release = temp.path().join("release");
    let mut child = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .arg("--exact")
        .arg("inbox::delete::tests::delete_lock_holder")
        .arg("--nocapture")
        .env("POKEDEX_TEST_DELETE_LOCK_ROOT", &inbox_root)
        .env("POKEDEX_TEST_DELETE_LOCK_READY", &ready)
        .env("POKEDEX_TEST_DELETE_LOCK_RELEASE", &release)
        .spawn()
        .expect("lock-holder process");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !ready.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(ready.exists(), "lock holder became ready");

    let release_path = release.clone();
    let releasing = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(75));
        std::fs::write(release_path, b"release").expect("release marker");
    });
    inbox
        .delete(scan.id)
        .expect("delete retries the short cross-process lease");
    releasing.join().expect("release thread");
    assert!(child.wait().expect("child exit").success());
    assert!(inbox.list().expect("empty inbox").is_empty());
}
