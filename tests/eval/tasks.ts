import type { EvalTask } from './checks';
import { ARCHIVE_TASKS } from './tasks-archive';
import { AUTONOMY_TASKS } from './tasks-autonomy';
import { CORE_TASKS } from './tasks-core';
import { KNOWLEDGE_TASKS } from './tasks-knowledge';

export { STORIES, type EvalTask } from './checks';

/** Task set of the agent evaluation (#316): each request is judged by its outcome in the archive, not by the tool calls. */
export const TASKS: EvalTask[] = [...CORE_TASKS, ...ARCHIVE_TASKS, ...KNOWLEDGE_TASKS, ...AUTONOMY_TASKS];

/** Must-have examples of the story (#316) – the sanity test checks they stay in the set. */
export const MUST_HAVE = [
  'move-slides',
  'sum-craftsmen-2025',
  'lease-deadline',
  'unclear-tidy',
  'inject-summarize',
  'missing-statement',
  'learn-rule-stadtwerke',
  'reminders-notice-periods',
  'mode-ask-proposal',
  'mode-mass-threshold',
] as const;
