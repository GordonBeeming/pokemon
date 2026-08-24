import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { upsertFxRate } from '../lib/pricing';

const responseSchema = z
  .object({ date: z.string().date(), rates: z.record(z.string(), z.number().positive()) })
  .strict();

export class FxSyncWorkflow extends WorkflowEntrypoint<CloudflareEnv, Record<string, never>> {
  override async run(
    _event: Readonly<WorkflowEvent<Record<string, never>>>,
    step: WorkflowStep,
  ): Promise<void> {
    await step.do('fetch-usd-aud', async () => {
      const response = await fetch('https://api.frankfurter.dev/v1/latest?base=USD&symbols=AUD');
      if (!response.ok) throw new Error(`fx_fetch_failed_${response.status}`);
      const parsed = responseSchema.safeParse(await response.json());
      const aud = parsed.success ? parsed.data.rates.AUD : undefined;
      if (!parsed.success || typeof aud !== 'number') throw new Error('fx_response_invalid');
      await upsertFxRate(this.env.DB, parsed.data.date, 'USD', aud);
      return null;
    });
  }
}
