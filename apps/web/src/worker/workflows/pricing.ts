import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import {
  applyStagedPrices,
  beginPriceSyncRun,
  cardRowsForPriceSources,
  cardSourcePage,
  extractTcgdexPrices,
  prunePricingData,
  setPriceSyncCursor,
  stagePriceTargets,
  stagePrices,
  upsertFxRate,
  type StagedPriceRow,
} from '../lib/pricing';
import { describeError, logInfo } from '../lib/log';
import { nowSeconds } from '../lib/db';
import { recordWorkflowFailure } from '../lib/workflow-failure';

const PRICE_SOURCE_PAGE = 1_000;
const OUTBOUND_CONCURRENCY = 5;
const DETAIL_MAX_BYTES = 2 * 1024 * 1024;
const PRICE_OBJECT_MAX_BYTES = 25 * 1024 * 1024;

const stagedPriceSchema = z
  .array(
    z
      .object({
        cardId: z.string().min(1),
        source: z.enum(['tcgplayer', 'cardmarket']),
        nativeAmount: z.number().positive(),
        nativeCurrency: z.string().regex(/^[A-Z]{3}$/u),
        sourceCapturedAt: z.number().int().nonnegative(),
      })
      .strict(),
  )
  .min(1);
const fxResponseSchema = z
  .object({ date: z.string().date(), rates: z.record(z.string(), z.number().positive()) })
  .strict();

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > DETAIL_MAX_BYTES) throw new Error('price_response_too_large');
  if (!response.body) throw new Error('price_response_empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > DETAIL_MAX_BYTES) {
      await reader.cancel();
      throw new Error('price_response_too_large');
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
    throw new Error(`price_response_invalid: ${describeError(error)}`);
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`price_fetch_failed_${response.status}`);
  }
  return boundedJson(response);
}

async function mapConcurrent<T, U>(values: T[], mapper: (value: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  for (let offset = 0; offset < values.length; offset += OUTBOUND_CONCURRENCY) {
    results.push(
      ...(await Promise.all(values.slice(offset, offset + OUTBOUND_CONCURRENCY).map(mapper))),
    );
  }
  return results;
}

async function ensureFxRates(db: D1Database, currencies: string[]): Promise<string> {
  const targets = [...new Set(currencies.filter((currency) => currency !== 'AUD'))].sort();
  if (targets.length === 0) return new Date().toISOString().slice(0, 10);
  const rates = await mapConcurrent(targets, async (currency) => {
    const parsed = fxResponseSchema.safeParse(
      await fetchJson(`https://api.frankfurter.dev/v1/latest?base=${currency}&symbols=AUD`),
    );
    const aud = parsed.success ? parsed.data.rates.AUD : undefined;
    if (!parsed.success || typeof aud !== 'number')
      throw new Error(`fx_response_invalid_${currency}`);
    await upsertFxRate(db, parsed.data.date, currency, aud);
    return parsed.data.date;
  });
  const dates = [...new Set(rates)];
  if (dates.length !== 1) throw new Error('fx_date_mismatch');
  return dates[0] ?? new Date().toISOString().slice(0, 10);
}

interface PriceWorkflowPayload {
  objectKey?: string;
  fxDate?: string;
}

export class PriceSyncWorkflow extends WorkflowEntrypoint<CloudflareEnv, PriceWorkflowPayload> {
  override async run(
    event: Readonly<WorkflowEvent<PriceWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<void> {
    const runId = `price_sync_${event.instanceId}`;
    const startedAt = Date.now();
    let currentStep = 'begin-price-run';
    try {
      await step.do('begin-price-run', () => beginPriceSyncRun(this.env.DB, runId));
      let rows: StagedPriceRow[];
      let targetCardIds: string[];
      let cursor: string | null = null;
      if (event.payload.objectKey) {
        currentStep = 'read-price-object';
        rows = await step.do('read-price-object', async () => {
          const object = await this.env.ART.get(event.payload.objectKey ?? '');
          if (!object) throw new Error('price_stage_missing');
          if (object.size > PRICE_OBJECT_MAX_BYTES) throw new Error('price_stage_too_large');
          const parsed = stagedPriceSchema.safeParse(await object.json<unknown>());
          if (!parsed.success) throw new Error('price_stage_invalid');
          return parsed.data;
        });
        targetCardIds = [...new Set(rows.map((row) => row.cardId))];
      } else {
        currentStep = 'select-price-sources';
        const page = await step.do('select-price-sources', () =>
          cardSourcePage(this.env.DB, PRICE_SOURCE_PAGE),
        );
        cursor = page.cursor;
        currentStep = 'fetch-price-sources';
        const prices = await step.do('fetch-price-sources', () =>
          mapConcurrent(page.ids, async (sourceId) =>
            extractTcgdexPrices(
              await fetchJson(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(sourceId)}`),
            ),
          ),
        );
        currentStep = 'map-price-sources';
        const mapped = await step.do('map-price-sources', () =>
          cardRowsForPriceSources(this.env.DB, prices),
        );
        rows = mapped.rows;
        targetCardIds = mapped.cardIds;
      }

      if (targetCardIds.length === 0) {
        currentStep = 'complete-empty-price-run';
        await step.do('complete-empty-price-run', async () => {
          await this.env.DB.prepare(
            `UPDATE price_sync_runs SET completed_at = ?1, status = 'complete', row_count = 0
             WHERE id = ?2 AND status = 'running'`,
          )
            .bind(nowSeconds(), runId)
            .run();
          if (!event.payload.objectKey) await setPriceSyncCursor(this.env.DB, cursor);
          return null;
        });
        return;
      }

      currentStep = 'stage-price-targets';
      await step.do('stage-price-targets', async () => {
        await stagePriceTargets(this.env.DB, runId, targetCardIds);
        return targetCardIds.length;
      });

      const fxDate =
        event.payload.fxDate ??
        (await (async () => {
          currentStep = 'refresh-price-fx';
          return step.do('refresh-price-fx', () =>
            ensureFxRates(
              this.env.DB,
              rows.map((row) => row.nativeCurrency),
            ),
          );
        })());
      currentStep = 'stage-prices';
      await step.do('stage-prices', async () => {
        await stagePrices(this.env.DB, runId, rows);
        return rows.length;
      });
      currentStep = 'apply-prices';
      const applied = await step.do('apply-prices', () =>
        applyStagedPrices(this.env.DB, runId, fxDate),
      );
      currentStep = 'cleanup-prices';
      await step.do('cleanup-prices', async () => {
        if (!event.payload.objectKey) await setPriceSyncCursor(this.env.DB, cursor);
        if (event.payload.objectKey?.startsWith('staged/prices/'))
          await this.env.ART.delete(event.payload.objectKey);
        await prunePricingData(this.env.DB);
        return null;
      });
      logInfo({
        evt: 'workflow.pricing.complete',
        workflowInstanceId: event.instanceId,
        runId,
        rows: applied,
        fxDate,
        cursor,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = describeError(error);
      await recordWorkflowFailure(
        {
          evt: 'workflow.pricing.failed',
          workflowInstanceId: event.instanceId,
          runId,
          step: currentStep,
          durationMs: Date.now() - startedAt,
          err: message,
          stack: error instanceof Error ? error.stack : undefined,
        },
        async () => {
          await this.env.DB.prepare(
            `UPDATE price_sync_runs SET completed_at = ?1, status = 'failed', error = ?2
           WHERE id = ?3 AND status = 'running'`,
          )
            .bind(nowSeconds(), message, runId)
            .run();
        },
      );
      throw error;
    }
  }
}
