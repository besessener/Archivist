import { abortedError, llmCancelScope } from '../llm';

/** Throws when the current request was cancelled – before anything else is changed. */
export function throwIfCancelled(): void {
  if (llmCancelScope.getStore()?.aborted) throw abortedError();
}
