/** Generous output limits (tokens) per structured answer: far above any real answer, only a runaway answer is cut. */
const OUTPUT_LIMITS: Record<string, number> = {
  DocumentClassification: 8000,
  KnowledgeAnswer: 4000,
  ChatIntent: 4000,
  SolutionProposal: 3000,
  NoteAnalysis: 2000,
  ContradictionProposal: 1500,
  DuplicateHints: 1500,
  PersonHints: 1500,
  RelationKindHint: 400,
  TopicName: 400,
};

/** Output limit for a structured answer; the caller applies it only where reasoning tokens cannot eat the budget. */
export const outputLimitFor = (schemaName: string): number | undefined => OUTPUT_LIMITS[schemaName];
