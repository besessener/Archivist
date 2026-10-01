import { appendFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';
import type { Result } from 'axe-core';

/** WCAG 2.2 AA. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag22aa'];

/** Regeln, die eslint-plugin-jsx-a11y bereits statisch prüft; axe ist für das gerenderte DOM da. */
const COVERED_BY_LINT = ['image-alt', 'aria-valid-attr-value', 'aria-allowed-attr'];

const describeViolation = (violation: Result) => {
  const targets = violation.nodes.slice(0, 3).map((node) => node.target.join(' '));
  return `${violation.id} (${violation.impact}): ${violation.help} – ${violation.nodes.length} Element(e): ${targets.join(' | ')}`;
};

/** Nicht blockierende Funde landen in der Job-Zusammenfassung der CI, damit sie beurteilt werden können. */
async function reportNonBlockingFindings(testInfo: TestInfo, violations: Result[]) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath || violations.length === 0) return;
  const title = testInfo.titlePath.slice(1).join(' › ');
  const body = violations.map((violation) => `- ${describeViolation(violation)}`).join('\n');
  await appendFile(
    summaryPath,
    `### ♿ Barrierefreiheit – ${title}\n\nNicht blockierend, bitte beurteilen (Details: Anhang \`axe-verstoesse.json\` am Test).\n\n${body}\n\n`,
  );
}

/** Schwere und kritische Funde lassen den Test fehlschlagen; mittlere und leichte werden angehängt und zusammengefasst. */
export async function expectNoSeriousA11yViolations(page: Page, testInfo: TestInfo) {
  // Legacy-Modus: der Standardmodus öffnet für die Auswertung eine neue Seite, was Electron nicht unterstützt (Target.createTarget).
  const results = await new AxeBuilder({ page }).setLegacyMode().withTags(WCAG_TAGS).disableRules(COVERED_BY_LINT).analyze();
  if (results.violations.length > 0) {
    await testInfo.attach('axe-verstoesse.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  }
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  await reportNonBlockingFindings(
    testInfo,
    results.violations.filter((violation) => !blocking.includes(violation)),
  );
  expect(blocking, blocking.map(describeViolation).join('\n')).toEqual([]);
}
