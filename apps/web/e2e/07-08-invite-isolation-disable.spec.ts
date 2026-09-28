import type { BrowserContext } from '@playwright/test';
import * as api from './support/api';
import { expect, test } from './support/fixtures';
import { hasCdp } from './support/layout';
import { findMissingCard } from './support/scenarios';

function tokenFromInviteUrl(inviteUrl: string): string {
  const token = new URL(inviteUrl).pathname.split('/').pop();
  if (!token) throw new Error(`Could not read a token out of ${inviteUrl}`);
  return token;
}

/**
 * Flows 7 and 8 share one invited account: 7 creates and registers it (proving
 * isolation from the moment it exists), 8 disables and re-enables that same account
 * (proving the refusal and the restore). They run in one file, in order, so the
 * second flow has a real signed-in guest session to disable.
 */
test.describe
  .serial('invite creates an isolated account; disabling refuses it, enabling restores it', () => {
  let guestUserId = '';
  let guestLabel = '';
  let guestCardId = '';
  let liveGuestContext: BrowserContext | undefined;

  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    test.skip(!hasCdp(testInfo), 'the virtual passkey authenticator is Chromium-only');
  });

  test('an invite link registers a brand-new, fully isolated account', async ({
    page,
    browser,
  }) => {
    guestLabel = `E2E guest ${Date.now()}`;
    const invite = await api.createInvite(page.request, { role: 'member', label: guestLabel });

    const adminBinders = await api.listBinders(page.request);
    const adminBinder = adminBinders[0];
    if (!adminBinder) throw new Error('Admin has no binders to check isolation against.');
    const dashboardBefore = await api.dashboard(page.request);

    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    const cdp = await guestContext.newCDPSession(guestPage);
    await cdp.send('WebAuthn.enable');
    const authenticator = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    });

    await guestPage.goto(`/invite/${tokenFromInviteUrl(invite.inviteUrl)}`);
    await expect(guestPage.getByRole('heading', { name: 'You’re invited' })).toBeVisible();
    await guestPage.getByLabel('Name this device').fill('E2E virtual device');
    await guestPage.getByRole('button', { name: 'Create my passkey' }).click();
    await expect(guestPage).toHaveURL(/\/$/);

    const me = await api.me(guestPage.request);
    guestUserId = me.sub;
    expect(me.label).toBe(guestLabel);
    expect(me.role).toBe('member');

    // Empty collection and binders for the brand-new account.
    const guestDashboard = await api.dashboard(guestPage.request);
    expect(guestDashboard.collection.uniqueOwned).toBe(0);
    const guestBinders = await api.listBinders(guestPage.request);
    expect(guestBinders).toEqual([]);

    // The admin's binder URL gives the not-found state for the new user.
    await guestPage.goto(`/binders/${adminBinder.id}?page=1&q=`);
    await expect(
      guestPage.getByRole('heading', { name: 'This binder is no longer available' }),
    ).toBeVisible();

    // The new user's own writes don't touch the admin's counts.
    const card = await findMissingCard(guestPage.request);
    guestCardId = card.id;
    await api.incrementCollection(guestPage.request, card.id, 1);
    const dashboardAfter = await api.dashboard(page.request);
    expect(dashboardAfter.collection).toEqual(dashboardBefore.collection);
    expect(dashboardAfter.pricing).toEqual(dashboardBefore.pricing);
    expect(dashboardAfter.binderCount).toEqual(dashboardBefore.binderCount);

    await cdp
      .send('WebAuthn.removeVirtualAuthenticator', {
        authenticatorId: authenticator.authenticatorId,
      })
      .catch(() => undefined);
    // Kept open (not closed) so flow 8 has a live, already-signed-in session to
    // disable mid-flight, per "the new user's existing session is refused".
    liveGuestContext = guestContext;
  });

  test('disabling refuses the existing session and sign-in; enabling restores access and data', async ({
    page,
    browser,
  }) => {
    if (!liveGuestContext)
      throw new Error('The invite step above did not leave a live guest session.');

    await page.goto('/settings?tab=people');
    const row = page.locator('.person-row', { hasText: guestLabel });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Disable' }).click();
    await expect(row.getByText('Disabled', { exact: true })).toBeVisible();

    // The guest's already-open session is refused on its very next request.
    const meAfterDisable = await liveGuestContext.request.get('/api/auth/me');
    expect(meAfterDisable.status()).toBe(401);

    // Signing in again fails with the disabled message.
    const retryContext = await browser.newContext();
    const loginAttempt = await retryContext.request.post('/api/auth/dev-login', {
      data: { userId: guestUserId },
    });
    expect(loginAttempt.status()).toBe(403);
    const loginBody: unknown = await loginAttempt.json();
    expect(loginBody).toMatchObject({ error: 'user_disabled' });

    await row.getByRole('button', { name: 'Enable' }).click();
    await expect(row.getByText('Active', { exact: true })).toBeVisible();

    // Signing back in works, and the one card added before disabling is intact.
    await api.devLoginAs(retryContext.request, guestUserId);
    const detail = await api.cardDetail(retryContext.request, guestCardId);
    expect(detail.collection?.quantity).toBe(1);

    await retryContext.close();
    await liveGuestContext.close();
  });
});
