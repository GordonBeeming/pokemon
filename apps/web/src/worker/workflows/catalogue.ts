import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { PHYSICAL_LANGUAGES, languageSchema } from '@pokedex/shared';
import { z } from 'zod';
import {
  applyStagedCatalogueRun,
  beginStagedCatalogueRun,
  stageCatalogueCards,
} from '../lib/catalogue';
import { newId, nowSeconds } from '../lib/db';
import { logInfo } from '../lib/log';

export class CatalogueSyncWorkflow extends WorkflowEntrypoint<
  CloudflareEnv,
  { language?: string; objectKey?: string; allowDestructiveDrop?: boolean }
> {
  override async run(
    event: Readonly<
      WorkflowEvent<{ language?: string; objectKey?: string; allowDestructiveDrop?: boolean }>
    >,
    step: WorkflowStep,
  ): Promise<void> {
    const objectKey = event.payload.objectKey;
    const requestedLanguage = event.payload.language;
    if (objectKey && requestedLanguage) {
      await step.do('apply-staged-catalogue', async () => {
        const object = await this.env.ART.get(objectKey);
        if (!object) throw new Error('catalogue_stage_missing');
        const parsed = z
          .array(
            z
              .object({
                sourceId: z.string().min(1),
                checksum: z.string().regex(/^[a-f0-9]{64}$/),
                sourceUpdatedAt: z.number().int().nonnegative(),
                name: z.string().min(1),
                language: languageSchema,
                category: z.enum(['pokemon', 'trainer', 'energy', 'special']),
                setId: z.string().min(1),
                setName: z.string().min(1),
                number: z.string().min(1),
                supertype: z.string().nullable().optional(),
                subtype: z.string().nullable().optional(),
                species: z.string().nullable().optional(),
                rarity: z.string().nullable().optional(),
                artist: z.string().nullable().optional(),
              })
              .strict(),
          )
          .min(1)
          .safeParse(await object.json<unknown>());
        if (!parsed.success) throw new Error('catalogue_stage_invalid');
        const first = parsed.data.at(0);
        if (!first || parsed.data.some((card) => card.language !== requestedLanguage))
          throw new Error('catalogue_stage_invalid');
        const runId = await beginStagedCatalogueRun(this.env.DB, first.language);
        await stageCatalogueCards(this.env.DB, runId, parsed.data);
        await applyStagedCatalogueRun(
          this.env.DB,
          runId,
          event.payload.allowDestructiveDrop ?? false,
        );
        return null;
      });
      return;
    }
    const languages = event.payload.language ? [event.payload.language] : PHYSICAL_LANGUAGES;
    for (const language of languages) {
      await step.do(`stage-${language}`, async () => {
        const response = await fetch(`https://api.tcgdex.net/v2/${language}/cards`);
        if (!response.ok) throw new Error(`tcgdex_fetch_failed_${language}_${response.status}`);
        const payload = await response.arrayBuffer();
        if (payload.byteLength === 0) throw new Error(`tcgdex_empty_${language}`);
        const id = newId('sync');
        const now = nowSeconds();
        const objectKey = `staged/tcgdex/${language}/${id}.json`;
        await this.env.ART.put(objectKey, payload, {
          httpMetadata: { contentType: 'application/json' },
        });
        await this.env.DB.prepare(
          'INSERT INTO sync_runs (id, provider, language, started_at, source_count, status, refusal_reason) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)',
        )
          .bind(id, 'tcgdex', language, now, 'running', `staged:${objectKey}`)
          .run();
        logInfo({
          evt: 'workflow.catalogue.staged',
          syncId: id,
          language,
          bytes: payload.byteLength,
        });
        return null;
      });
    }
  }
}
