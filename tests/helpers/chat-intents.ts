/** A ChatIntent answer of the fake LLM; whatever the test leaves out is that of an unrecognised message. */
export const intent = (overrides: Record<string, unknown>) => ({ intent: 'unknown', confidence: 0.9, rationale: 'test', ...overrides });

/** A decision as the fake LLM extracts it, without participants or alternatives unless the test sets them. */
export const extractedDecision = (overrides: Record<string, unknown> = {}) => ({
  participants: [],
  alternatives: [],
  unknownFields: [],
  confidence: 0.85,
  ...overrides,
});

/** The user's own message in a ChatIntent prompt, without the conversation history before it. */
export const userText = (input: string) => input.split('Nachricht des Benutzers:\n')[1] ?? '';
