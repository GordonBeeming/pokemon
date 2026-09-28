import { expect, type Page, type TestInfo } from '@playwright/test';

/** Every phone-sized project: Chromium at 390 and 360 wide, and WebKit as an iPhone 13. */
export function isPhoneProject(testInfo: TestInfo): boolean {
  return testInfo.project.name.startsWith('phone');
}

/** WebKit has no Chrome DevTools Protocol: raw touch streams and the virtual WebAuthn
 * authenticator are Chromium-only. */
export function hasCdp(testInfo: TestInfo): boolean {
  // A device descriptor (the iPhone 13 project) names its engine as the default
  // browser type rather than as browserName.
  const engine = testInfo.project.use.browserName ?? testInfo.project.use.defaultBrowserType;
  return engine === undefined || engine === 'chromium';
}

const OVERLAY_SELECTOR =
  '[role="dialog"], .menu-popover, .select-popover, .space-search-popover, .toast-viewport .toast';

interface LayoutProblem {
  what: string;
  left: number;
  right: number;
}

/**
 * Mobile layout rule 6: the page never scrolls sideways, and nothing that floats over
 * it (a sheet, dialog, menu, list or toast) runs past either edge of the screen.
 */
export async function expectLayoutSound(page: Page, where: string): Promise<void> {
  const report = await page.evaluate((selector) => {
    const width = window.innerWidth;
    const problems: LayoutProblem[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.left < -0.5 || box.right > width + 0.5)
        problems.push({
          what: `${element.tagName.toLowerCase()}.${element.className}`.slice(0, 80),
          left: Math.round(box.left),
          right: Math.round(box.right),
        });
    }
    return { scrollWidth: document.documentElement.scrollWidth, width, problems };
  }, OVERLAY_SELECTOR);
  expect(
    report.scrollWidth,
    `${where} scrolls sideways at ${report.width}px: ${JSON.stringify(report)}`,
  ).toBeLessThanOrEqual(report.width);
  expect(report.problems, `${where} has overlays past the screen edge`).toEqual([]);
}

/**
 * Rule 2: a toast never draws over an open sheet or dialog. Checks every visible toast
 * against every open dialog surface.
 */
export async function expectNoToastOverOverlay(page: Page): Promise<void> {
  const overlaps = await page.evaluate(() => {
    const toasts = Array.from(document.querySelectorAll('.toast-viewport .toast'));
    const surfaces = Array.from(document.querySelectorAll('[role="dialog"]'));
    const hits: string[] = [];
    for (const toast of toasts) {
      const a = toast.getBoundingClientRect();
      for (const surface of surfaces) {
        const b = surface.getBoundingClientRect();
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)
          hits.push(`${toast.textContent ?? ''} over ${surface.getAttribute('aria-label') ?? ''}`);
      }
    }
    return hits;
  });
  expect(overlaps, 'a toast is drawn over an open overlay').toEqual([]);
}
