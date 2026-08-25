import { describeError, logError, type LogFields } from './log';

export async function recordWorkflowFailure(
  fields: LogFields,
  writeFailureState?: () => Promise<void>,
): Promise<void> {
  let failureStateError: string | undefined;
  if (writeFailureState) {
    try {
      await writeFailureState();
    } catch (error) {
      failureStateError = describeError(error);
    }
  }
  logError({ ...fields, failureStateError });
}
