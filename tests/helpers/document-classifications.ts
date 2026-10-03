interface ClassificationFields {
  title: string;
  summary: string;
  categoryPath: string;
  [field: string]: unknown;
}

/** A DocumentClassification answer of the fake LLM filing a note under `categoryPath`; whatever the test leaves out stays empty. */
export const classification = ({ title, summary, categoryPath, ...fields }: ClassificationFields) => ({
  docType: 'Notiz',
  title,
  summary,
  mainTopic: null,
  project: null,
  persons: [],
  dates: [],
  tags: [],
  location: { categoryPath, fileName: null, newMainCategory: false, rationale: 'x', confidence: 0.7 },
  decisions: [],
  openItems: [],
  confidence: 0.7,
  rationale: 'x',
  ...fields,
});

/** A note about `topic`, filed under its project folder with a confident rationale – as the scanner sees one. */
export const topicNoteClassification = (topic: string, overrides: Record<string, unknown> = {}) => ({
  docType: 'Notiz',
  title: `Notiz ${topic}`,
  summary: `Notiz zu ${topic}.`,
  mainTopic: topic,
  project: null,
  persons: [],
  dates: [],
  tags: [topic.toLowerCase()],
  location: { categoryPath: `work/projects/${topic}`, fileName: null, newMainCategory: false, rationale: `Bezug zu ${topic}`, confidence: 0.8 },
  decisions: [],
  openItems: [],
  confidence: 0.8,
  rationale: 'test',
  ...overrides,
});
