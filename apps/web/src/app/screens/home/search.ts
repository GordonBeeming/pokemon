import { z } from 'zod';

const homeSearchSchema = z.object({ card: z.string().trim().min(1).max(128).optional() });
export type HomeSearch = z.infer<typeof homeSearchSchema>;

/**
 * Home's own tiny search-params contract: just the open card id, so the shelf's
 * card inspector lives in the URL and Back closes it instead of leaving Home — the
 * same "URL is state" rule every other screen's search schema follows. A stale or
 * hand-edited `?card=` degrades to "closed" rather than throwing.
 */
export const homeSearch = {
  parse: (raw: Record<string, unknown>): HomeSearch => {
    const result = homeSearchSchema.safeParse(raw);
    return result.success ? result.data : {};
  },
};
