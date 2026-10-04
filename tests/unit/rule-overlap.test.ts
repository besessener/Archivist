import { describe, expect, it } from 'vitest';
import type { RuleDefinition } from '@archivist/shared';
import { conditionsOverlap, ruleClash } from '../../packages/core/src/agent/rule-overlap';

const rule = (when: RuleDefinition['when'], then: RuleDefinition['then']): RuleDefinition => ({ when, then });

describe('overlapping rules', () => {
  it('conditions overlap when no named field excludes the other rule', () => {
    expect(conditionsOverlap({ sender: 'Stadtwerke' }, { sender: 'stadtwerke münchen' })).toBe(true);
    expect(conditionsOverlap({ sender: 'Stadtwerke' }, { sender: 'Telekom' })).toBe(false);
    expect(conditionsOverlap({ sender: 'Stadtwerke' }, { docType: 'Rechnung' })).toBe(true);
    expect(conditionsOverlap({ ext: '.pdf' }, { ext: 'pdf', docType: 'Rechnung' })).toBe(true);
    expect(conditionsOverlap({ ext: 'pdf' }, { ext: 'docx' })).toBe(false);
    expect(conditionsOverlap({ ext: 'pdf' }, { ext: 'pdfx' })).toBe(false);
    expect(conditionsOverlap({ ext: 'pdf' }, { sender: 'Stadtwerke' })).toBe(true);
  });

  it('names what the rules would do differently with the same document', () => {
    const existing = rule({ sender: 'Stadtwerke' }, { folder: 'privat/energie' });
    expect(ruleClash(existing, rule({ sender: 'Stadtwerke', docType: 'Rechnung' }, { folder: 'privat/rechnungen' }))).toContain('privat/energie');
    expect(ruleClash(existing, rule({ sender: 'Stadtwerke' }, { folder: 'Privat/Energie' }))).toBeNull();
    expect(ruleClash(existing, rule({ sender: 'Telekom' }, { folder: 'privat/telefon' }))).toBeNull();
    expect(ruleClash(rule({ docType: 'Rechnung' }, { topic: 'Energie' }), rule({ docType: 'Rechnung' }, { topic: 'Wohnen' }))).toContain('Thema');
    expect(ruleClash(rule({ docType: 'Rechnung' }, { topic: ' Energie ' }), rule({ docType: 'Rechnung' }, { topic: 'Energie' }))).toBeNull();
    expect(ruleClash(rule({ docType: 'Rechnung' }, { topic: 'Energie' }), rule({ docType: 'Rechnung' }, { tags: ['a'] }))).toBeNull();
    expect(ruleClash(rule({ docType: 'Rechnung' }, { tags: ['a'] }), rule({ docType: 'Rechnung' }, { folder: 'x' }))).toBeNull();
  });
});
