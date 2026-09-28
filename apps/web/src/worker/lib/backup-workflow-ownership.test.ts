import { describe, expect, it } from 'vitest';
import { signedBackupWorkflowId, verifyBackupWorkflowOwner } from './backup';

const SECRET = 'backup-workflow-ownership-test-secret';

// Cloudflare Workflows never hands back the params an instance was created
// with, so GET /backups/workflows/:id can only tell who owns an instance by
// checking a keyed-hash proof baked into the id at creation time.
describe('signed backup workflow ids', () => {
  it('verifies for the owner that created it', async () => {
    const id = await signedBackupWorkflowId('backup', 'owner-a', SECRET);
    expect(await verifyBackupWorkflowOwner(id, 'owner-a', SECRET)).toBe(true);
  });

  it('refuses another owner, even knowing the id', async () => {
    const id = await signedBackupWorkflowId('backup', 'owner-a', SECRET);
    expect(await verifyBackupWorkflowOwner(id, 'owner-b', SECRET)).toBe(false);
  });

  it('refuses a forged id that only guesses the shape', async () => {
    expect(
      await verifyBackupWorkflowOwner(
        `backup-${'a'.repeat(32)}-${crypto.randomUUID()}`,
        'owner-a',
        SECRET,
      ),
    ).toBe(false);
  });

  it('refuses an id signed under a different secret (e.g. a rotated SESSION_SECRET)', async () => {
    const id = await signedBackupWorkflowId('backup', 'owner-a', SECRET);
    expect(await verifyBackupWorkflowOwner(id, 'owner-a', 'a different secret entirely')).toBe(
      false,
    );
  });

  it('works the same for a restore id', async () => {
    const id = await signedBackupWorkflowId('restore', 'owner-a', SECRET);
    expect(await verifyBackupWorkflowOwner(id, 'owner-a', SECRET)).toBe(true);
    expect(await verifyBackupWorkflowOwner(id, 'owner-b', SECRET)).toBe(false);
  });

  it('rejects a malformed id outright', async () => {
    expect(await verifyBackupWorkflowOwner('not-a-workflow-id', 'owner-a', SECRET)).toBe(false);
  });

  it('still verifies against a previous secret after SESSION_SECRET rotates, so an in-flight poll is never orphaned', async () => {
    const oldSecret = 'the-old-rotated-out-secret';
    const id = await signedBackupWorkflowId('backup', 'owner-a', oldSecret);
    expect(await verifyBackupWorkflowOwner(id, 'owner-a', SECRET)).toBe(false);
    expect(await verifyBackupWorkflowOwner(id, 'owner-a', SECRET, oldSecret)).toBe(true);
  });

  it('does not accept a previous secret for the wrong owner', async () => {
    const oldSecret = 'the-old-rotated-out-secret';
    const id = await signedBackupWorkflowId('backup', 'owner-a', oldSecret);
    expect(await verifyBackupWorkflowOwner(id, 'owner-b', SECRET, oldSecret)).toBe(false);
  });

  it('ignores an absent previous secret rather than treating it as a match', async () => {
    const id = await signedBackupWorkflowId('backup', 'owner-a', 'some-other-secret');
    expect(await verifyBackupWorkflowOwner(id, 'owner-a', SECRET, undefined)).toBe(false);
  });
});
