/** Playwright's `name` matchers accept a RegExp, but a card's name or set code can
 * contain regex-special characters (e.g. "Mr. Mime", "Type: Null") — escape before
 * building one out of real card data. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
