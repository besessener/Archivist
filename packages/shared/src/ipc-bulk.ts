import { z } from 'zod';
import { ArchiveAllPreview, ArchiveAllSource, BulkEstimate, StartedJob } from './bulk';
import { Id } from './common';
import { Confirmed, channel } from './ipc-channel';

/** Channels of the bulk work on long lists (#228); merged into the IPC contract. */
export const bulkChannels = {
  /** What „Alle Vorschläge archivieren“ would do (changes nothing). */
  'documents:archiveAllPreview': channel(z.object({ source: ArchiveAllSource }), ArchiveAllPreview),
  /** Level 2: archives exactly the documents of a shown preview as copies in one job, in batches; new main categories only as far as approved; each document has its own audit entry and can be undone. */
  'documents:archiveAll': channel(z.object({ previewId: Id, confirmed: Confirmed, approveNewCategories: z.array(z.string()).default([]) }), StartedJob),
  /** The documents a finished import analysed locally: how many may go to the LLM and roughly how many tokens. */
  'documents:analyzeImportEstimate': channel(z.object({ jobId: Id }), BulkEstimate),
  /** Analyses those documents again with the LLM; `confirmLlm` is the one consent for the whole run. */
  'documents:analyzeImport': channel(z.object({ jobId: Id, confirmLlm: z.literal(true) }), StartedJob),
} as const;
