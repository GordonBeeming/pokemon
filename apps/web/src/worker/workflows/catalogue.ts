import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { PHYSICAL_LANGUAGES, languageSchema, type LanguageCode } from '@pokedex/shared';
import { z } from 'zod';
import {
  applyStagedCatalogueRun,
  beginStagedCatalogueRun,
  setImportedCardReleaseDate,
  stageCatalogueCards,
  transformTcgdexCard,
  type ImportedCard,
} from '../lib/catalogue';
import { nowSeconds } from '../lib/db';
import { describeError, logError, logInfo } from '../lib/log';

const LIST_MAX_BYTES = 25 * 1024 * 1024;
const DETAIL_MAX_BYTES = 2 * 1024 * 1024;
const DETAIL_CHUNK_SIZE = 250;
const OUTBOUND_CONCURRENCY = 5;
const FETCH_STEP_CONFIG = {
  retries: { limit: 4, delay: 1_000, backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

const cardBriefsSchema = z
  .array(z.object({ id: z.string().trim().min(1).max(256) }).passthrough())
  .max(50_000);
const setSchema = z
  .object({ id: z.string().trim().min(1), releaseDate: z.string().date().nullable().optional() })
  .passthrough();
const importedCardsSchema = z.array(
  z
    .object({
      sourceId: z.string().min(1),
      checksum: z.string().regex(/^[a-f0-9]{64}$/u),
      sourceUpdatedAt: z.number().int().nonnegative(),
      name: z.string().min(1),
      language: languageSchema,
      category: z.enum(['pokemon', 'trainer', 'energy', 'special']),
      setId: z.string().min(1),
      setName: z.string().min(1),
      number: z.string().min(1),
      numberSort: z.number().int().nonnegative().nullable().optional(),
      supertype: z.string().nullable().optional(),
      subtype: z.string().nullable().optional(),
      species: z.string().nullable().optional(),
      rarity: z.string().nullable().optional(),
      artist: z.string().nullable().optional(),
      releaseDate: z.string().date().nullable().optional(),
      pokedexNumber: z.number().int().positive().nullable().optional(),
    })
    .strict(),
);
const catalogueObjectSchema = z.union([
  importedCardsSchema,
  z
    .object({ provider: z.literal('tcgdex'), language: languageSchema, cards: importedCardsSchema })
    .strict()
    .transform((value) => value.cards),
]);

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maximumBytes) throw new Error('tcgdex_response_too_large');
  if (!response.body) throw new Error('tcgdex_response_empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error('tcgdex_response_too_large');
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error(`tcgdex_response_invalid: ${describeError(error)}`);
  }
}

async function fetchTcgdex(path: string, maximumBytes: number): Promise<unknown> {
  const response = await fetch(`https://api.tcgdex.net/v2/${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`tcgdex_fetch_failed_${response.status}`);
  }
  return boundedJson(response, maximumBytes);
}

async function mapConcurrent<T, U>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const mapped: U[] = [];
  for (let offset = 0; offset < values.length; offset += concurrency) {
    mapped.push(...(await Promise.all(values.slice(offset, offset + concurrency).map(mapper))));
  }
  return mapped;
}

function scheduledLanguage(event: Readonly<WorkflowEvent<CatalogueWorkflowPayload>>): LanguageCode {
  const requested = languageSchema.safeParse(event.payload.language);
  if (requested.success) return requested.data;
  if (!event.schedule) return 'en';
  const day = Math.floor(event.schedule.scheduledTime / 86_400_000);
  return PHYSICAL_LANGUAGES[day % PHYSICAL_LANGUAGES.length] ?? 'en';
}

async function fetchLanguageCards(
  language: LanguageCode,
  step: WorkflowStep,
): Promise<ImportedCard[]> {
  const briefs = await step.do(`list-${language}-cards`, FETCH_STEP_CONFIG, async () => {
    const parsed = cardBriefsSchema.safeParse(
      await fetchTcgdex(`${encodeURIComponent(language)}/cards`, LIST_MAX_BYTES),
    );
    if (!parsed.success) throw new Error('tcgdex_card_list_invalid');
    return parsed.data.map((card) => card.id);
  });
  const cards: ImportedCard[] = [];
  for (let offset = 0; offset < briefs.length; offset += DETAIL_CHUNK_SIZE) {
    const ids = briefs.slice(offset, offset + DETAIL_CHUNK_SIZE);
    const page = Math.floor(offset / DETAIL_CHUNK_SIZE);
    const transformed = await step.do(`detail-${language}-${page}`, FETCH_STEP_CONFIG, async () => {
      const values = await mapConcurrent(ids, OUTBOUND_CONCURRENCY, (id) =>
        fetchTcgdex(
          `${encodeURIComponent(language)}/cards/${encodeURIComponent(id)}`,
          DETAIL_MAX_BYTES,
        ),
      );
      const results = await Promise.all(
        values.map((value) => transformTcgdexCard(value, language)),
      );
      return results.filter((card): card is ImportedCard => card !== null);
    });
    cards.push(...transformed);
  }

  const setIds = [...new Set(cards.map((card) => card.setId))].sort();
  const releaseDates = new Map<string, string | null>();
  for (let offset = 0; offset < setIds.length; offset += DETAIL_CHUNK_SIZE) {
    const ids = setIds.slice(offset, offset + DETAIL_CHUNK_SIZE);
    const page = Math.floor(offset / DETAIL_CHUNK_SIZE);
    const setDates = await step.do(`sets-${language}-${page}`, FETCH_STEP_CONFIG, async () =>
      mapConcurrent(ids, OUTBOUND_CONCURRENCY, async (id) => {
        const parsed = setSchema.safeParse(
          await fetchTcgdex(
            `${encodeURIComponent(language)}/sets/${encodeURIComponent(id)}`,
            DETAIL_MAX_BYTES,
          ),
        );
        if (!parsed.success) throw new Error('tcgdex_set_invalid');
        return { id: parsed.data.id, releaseDate: parsed.data.releaseDate ?? null };
      }),
    );
    for (const set of setDates) releaseDates.set(set.id, set.releaseDate);
  }
  return Promise.all(
    cards.map((card) => setImportedCardReleaseDate(card, releaseDates.get(card.setId) ?? null)),
  );
}

interface CatalogueWorkflowPayload {
  language?: string;
  objectKey?: string;
  allowDestructiveDrop?: boolean;
}

export class CatalogueSyncWorkflow extends WorkflowEntrypoint<
  CloudflareEnv,
  CatalogueWorkflowPayload
> {
  override async run(
    event: Readonly<WorkflowEvent<CatalogueWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<void> {
    const language = scheduledLanguage(event);
    const runId = `sync_${event.instanceId}`;
    const startedAt = Date.now();
    let currentStep = 'begin-catalogue-run';
    try {
      await step.do('begin-catalogue-run', async () =>
        beginStagedCatalogueRun(this.env.DB, language, {
          runId,
          complete: true,
          objectKey: event.payload.objectKey ?? null,
        }),
      );
      currentStep = event.payload.objectKey ? 'read-catalogue-object' : 'fetch-language-cards';
      const cards = event.payload.objectKey
        ? await step.do('read-catalogue-object', async () => {
            const object = await this.env.ART.get(event.payload.objectKey ?? '');
            if (!object) throw new Error('catalogue_stage_missing');
            if (object.size > LIST_MAX_BYTES) throw new Error('catalogue_stage_too_large');
            const parsed = catalogueObjectSchema.safeParse(await object.json<unknown>());
            if (!parsed.success || parsed.data.some((card) => card.language !== language))
              throw new Error('catalogue_stage_invalid');
            return parsed.data;
          })
        : await fetchLanguageCards(language, step);

      for (let offset = 0; offset < cards.length; offset += DETAIL_CHUNK_SIZE) {
        const page = Math.floor(offset / DETAIL_CHUNK_SIZE);
        const chunk = cards.slice(offset, offset + DETAIL_CHUNK_SIZE);
        currentStep = `stage-${language}-${page}`;
        await step.do(`stage-${language}-${page}`, async () => {
          await stageCatalogueCards(this.env.DB, runId, chunk);
          return chunk.length;
        });
      }
      currentStep = 'apply-catalogue-run';
      const applied = await step.do('apply-catalogue-run', async () =>
        applyStagedCatalogueRun(this.env.DB, runId, event.payload.allowDestructiveDrop ?? false),
      );
      currentStep = 'cleanup-catalogue-run';
      await step.do('cleanup-catalogue-run', async () => {
        if (event.payload.objectKey?.startsWith('staged/tcgdex/'))
          await this.env.ART.delete(event.payload.objectKey);
        await this.env.DB.prepare(
          `DELETE FROM sync_runs
           WHERE completed_at < ?1 AND status IN ('complete', 'rejected', 'failed')`,
        )
          .bind(nowSeconds() - 90 * 24 * 60 * 60)
          .run();
        return null;
      });
      logInfo({
        evt: 'workflow.catalogue.complete',
        runId,
        language,
        imported: applied.imported,
        inactive: applied.inactive,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = describeError(error);
      await this.env.DB.prepare(
        `UPDATE sync_runs SET completed_at = ?1, status = 'failed', refusal_reason = ?2
         WHERE id = ?3 AND status = 'running'`,
      )
        .bind(nowSeconds(), message, runId)
        .run();
      logError({
        evt: 'workflow.catalogue.failed',
        workflowInstanceId: event.instanceId,
        runId,
        language,
        step: currentStep,
        durationMs: Date.now() - startedAt,
        err: message,
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }
}
