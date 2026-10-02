import { appendFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';
import type { Result } from 'axe-core';

/** WCAG 2.2 AA. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag22aa'];

/** Rules that eslint-plugin-jsx-a11y already checks statically; axe is for the rendered DOM. */
const COVERED_BY_LINT = ['image-alt', 'aria-valid-attr-value', 'aria-allowed-attr'];

const describeViolation = (violation: Result) => {
  const targets = violation.nodes.slice(0, 3).map((node) => node.target.join(' '));
  return `${violation.id} (${violation.impact}): ${violation.help} – ${violation.nodes.length} element(s): ${targets.join(' | ')}`;
};

/** Non-blocking findings go into the CI job summary so that they can be assessed. */
async function reportNonBlockingFindings(testInfo: TestInfo, violations: Result[]) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath || violations.length === 0) return;
  const title = testInfo.titlePath.slice(1).join(' › ');
  const body = violations.map((violation) => `- ${describeViolation(violation)}`).join('\n');
  await appendFile(
    summaryPath,
    `### ♿ Accessibility – ${title}\n\nNon-blocking, please assess (details: attachment \`axe-violations.json\` on the test).\n\n${body}\n\n`,
  );
}

/** Serious and critical findings fail the test; moderate and minor ones are attached and summarised. */
export async function expectNoSeriousA11yViolations(page: Page, testInfo: TestInfo) {
  // Legacy mode: the default mode opens a new page for the analysis, which Electron does not support (Target.createTarget).
  const results = await new AxeBuilder({ page }).setLegacyMode().withTags(WCAG_TAGS).disableRules(COVERED_BY_LINT).analyze();
  if (results.violations.length > 0) {
    await testInfo.attach('axe-violations.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  }
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  await reportNonBlockingFindings(
    testInfo,
    results.violations.filter((violation) => !blocking.includes(violation)),
  );
  expect(blocking, blocking.map(describeViolation).join('\n')).toEqual([]);
}
