import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { upsertFxRate } from '../lib/pricing';
import { describeError, logInfo } from '../lib/log';
import { recordWorkflowFailure } from '../lib/workflow-failure';

const responseSchema = z
  .object({ date: z.string().date(), rates: z.record(z.string(), z.number().positive()) })
  .strict();

export class FxSyncWorkflow extends WorkflowEntrypoint<CloudflareEnv, { currencies?: string[] }> {
  override async run(
    event: Readonly<WorkflowEvent<{ currencies?: string[] }>>,
    step: WorkflowStep,
  ): Promise<void> {
    const startedAt = Date.now();
    const currentStep = 'fetch-aud-rates';
    const runId = `fx_sync_${event.instanceId}`;
    try {
      await step.do('fetch-aud-rates', async () => {
        const currencies =
          event.payload.currencies?.filter(
            (currency) => /^[A-Z]{3}$/.test(currency) && currency !== 'AUD',
          ) ?? [];
        const stored = await this.env.DB.prepare(
          `SELECT native_currency FROM card_current_prices WHERE native_currency <> 'AUD'
         UNION
         SELECT native_currency FROM price_stage_rows WHERE native_currency <> 'AUD'`,
        ).all<{ native_currency: string }>();
        const targets = [
          ...new Set([...currencies, ...stored.results.map((row) => row.native_currency)]),
        ];
        for (const currency of targets) {
          const response = await fetch(
            `https://api.frankfurter.dev/v1/latest?base=${currency}&symbols=AUD`,
            { signal: AbortSignal.timeout(30_000) },
          );
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`fx_fetch_failed_${currency}_${response.status}`);
          }
          const parsed = responseSchema.safeParse(await response.json());
          const aud = parsed.success ? parsed.data.rates.AUD : undefined;
          if (!parsed.success || typeof aud !== 'number')
            throw new Error(`fx_response_invalid_${currency}`);
          await upsertFxRate(this.env.DB, parsed.data.date, currency, aud);
        }
        logInfo({
          evt: 'workflow.fx.complete',
          workflowInstanceId: event.instanceId,
          runId,
          currencies: targets.length,
          durationMs: Date.now() - startedAt,
        });
        return null;
      });
    } catch (error) {
      await recordWorkflowFailure({
        evt: 'workflow.fx.failed',
        workflowInstanceId: event.instanceId,
        runId,
        step: currentStep,
        durationMs: Date.now() - startedAt,
        err: describeError(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }
}
