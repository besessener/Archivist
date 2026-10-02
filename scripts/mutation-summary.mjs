// Writes the mutation test report (reports/mutation/mutation.json) as a Markdown table, e.g. into $GITHUB_STEP_SUMMARY.
import fs from 'node:fs';

const report = JSON.parse(fs.readFileSync(process.argv[2] ?? 'reports/mutation/mutation.json', 'utf8'));
const rows = [];
let totals = { killed: 0, survived: 0, noCoverage: 0, other: 0 };
for (const [file, data] of Object.entries(report.files)) {
  const count = { killed: 0, survived: 0, noCoverage: 0, other: 0 };
  for (const mutant of data.mutants) {
    if (mutant.status === 'Killed' || mutant.status === 'Timeout') count.killed += 1;
    else if (mutant.status === 'Survived') count.survived += 1;
    else if (mutant.status === 'NoCoverage') count.noCoverage += 1;
    else count.other += 1;
  }
  const detected = count.killed;
  const valid = count.killed + count.survived + count.noCoverage;
  rows.push(`| \`${file}\` | ${valid ? ((detected / valid) * 100).toFixed(1) : '–'} % | ${count.killed} | ${count.survived} | ${count.noCoverage} |`);
  for (const key of Object.keys(totals)) totals[key] += count[key];
}
const valid = totals.killed + totals.survived + totals.noCoverage;
const lines = [
  '## Mutation test',
  '',
  '| File | Score | killed | survived | no coverage |',
  '|---|---|---|---|---|',
  ...rows,
  `| **total** | **${valid ? ((totals.killed / valid) * 100).toFixed(1) : '–'} %** | ${totals.killed} | ${totals.survived} | ${totals.noCoverage} |`,
  '',
  `Thresholds: ${JSON.stringify(report.thresholds ?? {})}. Surviving mutants in the HTML report (artifact \`mutation-report\`).`,
];
console.log(lines.join('\n'));
