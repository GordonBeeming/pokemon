import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';
import { applyStagedPrices, stagePrices } from '../lib/pricing';

const stagedPriceSchema = z
  .array(
    z
      .object({
        cardId: z.string().min(1),
        source: z.enum(['tcgplayer', 'cardmarket']),
        nativeAmount: z.number().positive(),
        nativeCurrency: z.string().regex(/^[A-Z]{3}$/),
        sourceCapturedAt: z.number().int().nonnegative(),
      })
      .strict(),
  )
  .min(1);

export class PriceSyncWorkflow extends WorkflowEntrypoint<
  CloudflareEnv,
  { objectKey?: string; fxDate?: string }
> {
  override async run(
    event: Readonly<WorkflowEvent<{ objectKey?: string; fxDate?: string }>>,
    step: WorkflowStep,
  ): Promise<void> {
    await step.do('apply-staged-prices', async () => {
      if (!event.payload.objectKey || !event.payload.fxDate)
        throw new Error('price_stage_parameters_missing');
      const object = await this.env.ART.get(event.payload.objectKey);
      if (!object) throw new Error('price_stage_missing');
      const parsed = stagedPriceSchema.safeParse(await object.json<unknown>());
      if (!parsed.success) throw new Error('price_stage_invalid');
      const runId = `price_stage_${crypto.randomUUID()}`;
      await stagePrices(this.env.DB, runId, parsed.data);
      await applyStagedPrices(this.env.DB, runId, event.payload.fxDate);
      return null;
    });
  }
}
