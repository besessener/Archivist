import { describe, expect, it } from 'vitest';
import { sha256Text } from '../../packages/core/src/util/hash';
import {
  documentPairHash,
  documentPairKey,
  documentPairs,
  documentStatement,
  MAX_DOCUMENT_REVIEWS_PER_SCAN,
} from '../../packages/core/src/services/document-contradiction-rules';

describe('documentStatement', () => {
  it('joins title, summary and text start line by line and skips what is empty', () => {
    expect(documentStatement({ title: 'Angebot', summary: 'Kurz', text: 'Beginn' })).toBe('Angebot\nKurz\nBeginn');
    expect(documentStatement({ title: 'Angebot', summary: null, text: 'Beginn' })).toBe('Angebot\nBeginn');
    expect(documentStatement({ title: 'Angebot', summary: '', text: '' })).toBe('Angebot');
  });

  it('keeps a summary of 600 characters and shortens a longer one to 600 with an ellipsis', () => {
    const exact = 'a'.repeat(600);
    expect(documentStatement({ title: 't', summary: exact, text: '' })).toBe(`t\n${exact}`);
    expect(documentStatement({ title: 't', summary: `${exact}b`, text: '' })).toBe(`t\n${'a'.repeat(599)}…`);
  });

  it('keeps a text of 1200 characters and shortens a longer one to 1200 with an ellipsis', () => {
    const exact = 'a'.repeat(1200);
    expect(documentStatement({ title: 't', summary: null, text: exact })).toBe(`t\n${exact}`);
    expect(documentStatement({ title: 't', summary: null, text: `${exact}b` })).toBe(`t\n${'a'.repeat(1199)}…`);
  });
});

describe('pair identity', () => {
  it('hashes both statements independent of their order, and differently for other texts', () => {
    expect(documentPairHash('eins', 'zwei')).toBe(documentPairHash('zwei', 'eins'));
    expect(documentPairHash('eins', 'zwei')).not.toBe(documentPairHash('eins', 'drei'));
    expect(documentPairHash('eins', 'zwei')).toBe(sha256Text('document\neins\nzwei'));
  });

  it('keys a pair by both ids independent of their order', () => {
    expect(documentPairKey('b', 'a')).toBe('document:a|b');
    expect(documentPairKey('a', 'b')).toBe('document:a|b');
  });

  it('asks at most 30 questions per scan', () => {
    expect(MAX_DOCUMENT_REVIEWS_PER_SCAN).toBe(30);
  });
});

describe('documentPairs', () => {
  const doc = (id: string, statement: string, scope: { topicId?: string; projectId?: string } = { topicId: 't' }) => ({
    id,
    topicId: scope.topicId ?? null,
    projectId: scope.projectId ?? null,
    statement,
  });
  const budget = 'Dachsanierung Angebot Budget Euro';
  const ids = (pairs: Array<[{ id: string }, { id: string }]>) => pairs.map(([a, b]) => `${a.id}${b.id}`);

  it('pairs documents of one scope that share two distinctive words, in the order of the candidates', () => {
    expect(ids(documentPairs([doc('a', budget), doc('b', budget), doc('c', budget)]))).toEqual(['ab', 'ac', 'bc']);
  });

  it('leaves out documents that share only one word, or nothing', () => {
    expect(documentPairs([doc('a', 'Dachsanierung Angebot Budget'), doc('b', 'Dachsanierung Rechnung Strom')])).toEqual([]);
    expect(documentPairs([doc('a', 'Dachsanierung Angebot'), doc('b', 'Gemeindehaus Vorstand')])).toEqual([]);
  });

  it('pairs a document with a single distinctive word with one that has that word', () => {
    expect(ids(documentPairs([doc('a', 'Dachsanierung'), doc('b', 'Dachsanierung Angebot Budget')]))).toEqual(['ab']);
  });

  it('does not pair documents of different scopes and lists a pair of topic and project once', () => {
    expect(documentPairs([doc('a', budget, { topicId: 'x' }), doc('b', budget, { topicId: 'y' })])).toEqual([]);
    expect(ids(documentPairs([doc('a', budget, { topicId: 't', projectId: 'p' }), doc('b', budget, { topicId: 't', projectId: 'p' })]))).toEqual(['ab']);
  });

  it('compares only the 40 newest documents of a scope', () => {
    const candidates = Array.from({ length: 41 }, (_, index) => doc(`d${index}`, budget));
    const pairs = documentPairs(candidates);
    expect(pairs).toHaveLength((40 * 39) / 2);
    expect(pairs.flat().some((candidate) => candidate.id === 'd40')).toBe(false);
    expect(pairs.flat().some((candidate) => candidate.id === 'd39')).toBe(true);
  });
});
