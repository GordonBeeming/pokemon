import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  csvGroups,
  csvProducts,
  importSupplementalProducts,
  supplementalSets,
} from '../lib/tcgcsv';
import { getArtResponse } from '../lib/art';
import { describeError, logInfo, logError } from '../lib/log';
import { supplementalArtCandidates } from '../lib/supplemental-art';

export class SupplementalSyncWorkflow extends WorkflowEntrypoint<
  CloudflareEnv,
  Record<string, never>
> {
  override async run(
    event: Readonly<WorkflowEvent<Record<string, never>>>,
    step: WorkflowStep,
  ): Promise<void> {
    try {
      const failures: string[] = [];
      const sets = await step
        .do('discover-supplemental-sets', async () =>
          supplementalSets(this.env.DB, (await csvGroups(this.env.ART)).results),
        )
        .catch((error: unknown) => {
          failures.push('discovery');
          logError({ evt: 'workflow.supplemental.discovery_failed', err: describeError(error) });
          return [];
        });
      let imported = 0;
      for (const { group, set } of sets) {
        imported += await step
          .do(`import-group-${group.groupId}`, async () =>
            importSupplementalProducts(
              this.env.DB,
              group,
              set,
              (await csvProducts(this.env.ART, group.groupId)).results,
            ),
          )
          .catch((error: unknown) => {
            failures.push(String(group.groupId));
            logError({
              evt: 'workflow.supplemental.group_failed',
              groupId: group.groupId,
              err: describeError(error),
            });
            return 0;
          });
      }
      // Prioritise cards people already use. Limiting each run leaves capacity
      // for the next night's retry if a provider has a prolonged outage.
      const missing = await step.do('find-missing-art', () =>
        supplementalArtCandidates(this.env.DB, Math.floor(event.timestamp.getTime() / 86_400_000)),
      );
      let warmed = 0;
      for (const { id } of missing) {
        warmed += await step.do(`art-${id}`, async () => {
          let found = 0;
          for (const variant of ['low', 'high'] as const) {
            const response = await getArtResponse(
              this.env.DB,
              this.env.ART,
              'owner',
              id,
              variant,
              new Request('https://pokedex.invalid/art'),
            );
            if (response) {
              await response.body?.cancel();
              found++;
            }
          }
          return found;
        });
      }
      if (failures.length) throw new Error(`supplemental_partial_failure:${failures.join(',')}`);
      logInfo({
        evt: 'workflow.supplemental.complete',
        workflowInstanceId: event.instanceId,
        imported,
        warmed,
      });
    } catch (error) {
      logError({
        evt: 'workflow.supplemental.failed',
        workflowInstanceId: event.instanceId,
        err: describeError(error),
      });
      throw error;
    }
  }
}
