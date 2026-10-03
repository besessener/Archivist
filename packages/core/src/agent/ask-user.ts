import { z } from 'zod';
import { defineTool, type AgentTool } from './registry';

/** The tool that leaves the loop with a question to the user (#295); the answer continues the run with full context. */
export const ASK_USER = 'ask_user';

export const AskUserArgs = z.object({
  question: z.string().min(1).describe('Die Rückfrage an den Benutzer, kurz und konkret'),
  options: z.array(z.string().min(1).max(80)).max(6).default([]).describe('Antwortknöpfe, wo sinnvoll (z. B. ["Ja", "Nein"])'),
});

export interface UserQuestion {
  callId: string;
  text: string;
  options: string[];
}

/** Chat runs only: background runs have nobody to ask. */
export function askUserTool(): AgentTool {
  return defineTool({
    name: ASK_USER,
    description:
      'Rückfrage an den Benutzer, wenn etwas unklar ist und du es nicht selbst herausfinden kannst. Der Lauf wartet auf die Antwort und setzt dann mit vollem Kontext fort.',
    schema: AskUserArgs,
    risk: 'read',
    label: () => 'Rückfrage an dich',
    run: async () => ({ content: '' }),
  });
}
