import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';

// The periodic check notices archive files whose size no longer matches the archived document (#239).

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'local_only' });
});
afterEach(async () => app.cleanup());

async function archived(name: string, content: string): Promise<string> {
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}`, content)] });
  await app.services.jobs.whenIdle();
  const res = await app.ok('documents:archive', {
    items: [{ documentId: imp.imported[0]!.id, mode: 'copy', categoryPath: 'private/belege' }],
    confirmed: true,
    approveNewCategories: ['private'],
    confirmMove: false,
  } as never);
  expect(res.success).toBe(1);
  return res.items[0]!.targetPath!;
}

const changedFileHints = async () => (await app.ok('insights:list', {})).filter((i) => i.title.includes('Archivdatei verändert'));

describe('Archive check: changed archive files', () => {
  it('reports a file with another size and drops the hint once it is restored', async () => {
    const target = await archived('beleg.txt', 'Quittung über 12 Euro');
    await archived('anderer.txt', 'Unberührte Quittung');
    await app.services.consistency.run();
    expect(await changedFileHints()).toEqual([]);

    fs.writeFileSync(target, 'Quittung');
    await app.services.consistency.run();
    const hints = await changedFileHints();
    expect(hints).toHaveLength(1);
    expect(hints[0]!.title).toContain('beleg');

    fs.writeFileSync(target, 'Quittung über 12 Euro');
    await app.services.consistency.run();
    expect(await changedFileHints()).toEqual([]);
  });
});
