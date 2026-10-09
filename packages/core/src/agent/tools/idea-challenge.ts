import { z } from 'zod';
import { truncate } from '../../util/text';
import { defineTool, list, type AgentTool } from '../registry';
import type { ToolDeps } from './common';

/** Challenging an idea of the user (#384): the same checked answer as the chat's „Idee hinterfragen“; changes nothing. */
export function ideaChallengeTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      name: 'challenge_idea',
      description:
        'Hinterfragt eine Idee oder einen Plan des Benutzers („Ich überlege, …“, „Spricht etwas dagegen, …?“) anhand des Archivs: was dagegen spricht, was dafür spricht und was betroffen wäre – frühere Entscheidungen, Fakten, offene Punkte und Dokumente, jeder Punkt gegen seine Quellen geprüft, Unbelegtes verworfen. Ändert nichts. idea: die Idee in einem Satz; alternativeQueries: andere Suchbegriffe (Synonyme, andere Sprache).',
      schema: z.object({ idea: z.string().min(3), alternativeQueries: list.nullish() }),
      risk: 'read',
      label: (a) => `Hinterfrage die Idee „${truncate(a.idea, 60)}“`,
      run: async (a) => ({ content: await deps.answers.challengedIdea(a.idea, a.alternativeQueries ?? null), summary: 'geprüft' }),
    }),
  ];
}
