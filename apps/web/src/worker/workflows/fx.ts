import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { upsertFxRate } from '../lib/pricing';

const responseSchema = z
  .object({ date: z.string().date(), rates: z.record(z.string(), z.number().positive()) })
  .strict();

export class FxSyncWorkflow extends WorkflowEntrypoint<CloudflareEnv, { currencies?: string[] }> {
  override async run(
    event: Readonly<WorkflowEvent<{ currencies?: string[] }>>,
    step: WorkflowStep,
  ): Promise<void> {
    await step.do('fetch-aud-rates', async () => {
      const currencies =
        event.payload.currencies?.filter(
          (currency) => /^[A-Z]{3}$/.test(currency) && currency !== 'AUD',
        ) ?? [];
      const staged = await this.env.DB.prepare(
        "SELECT DISTINCT native_currency FROM price_stage_rows WHERE native_currency <> 'AUD'",
      ).all<{ native_currency: string }>();
      const targets = [
        ...new Set([...currencies, ...staged.results.map((row) => row.native_currency)]),
      ];
      for (const currency of targets) {
        const response = await fetch(
          `https://api.frankfurter.dev/v1/latest?base=${currency}&symbols=AUD`,
        );
        if (!response.ok) throw new Error(`fx_fetch_failed_${currency}_${response.status}`);
        const parsed = responseSchema.safeParse(await response.json());
        const aud = parsed.success ? parsed.data.rates.AUD : undefined;
        if (!parsed.success || typeof aud !== 'number')
          throw new Error(`fx_response_invalid_${currency}`);
        await upsertFxRate(this.env.DB, parsed.data.date, currency, aud);
      }
      return null;
    });
  }
}
