/** New Workflow runs use a reserved namespace. Older scheduled/API runs used sync_catalogue-. */
export function catalogueWorkflowId(runId: string): string | null {
  if (runId.startsWith('workflow_')) return runId.slice('workflow_'.length) || null;
  if (runId.startsWith('sync_catalogue-')) return runId.slice('sync_'.length);
  return null;
}
