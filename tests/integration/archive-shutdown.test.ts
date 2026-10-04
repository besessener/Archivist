import fsp from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/harness';
import { classification } from '../helpers/document-classifications';

// Quitting must not pull the database away from an archive operation that is still running.

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp({ privacy: 'auto' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.cleanup();
});

const realCopyFile = fsp.copyFile.bind(fsp);

async function imported(name: string) {
  app.llm.on('DocumentClassification', () =>
    classification({ title: name, summary: `Zusammenfassung ${name}`, categoryPath: 'Arbeit/notes', mainTopic: null }),
  );
  const imp = await app.ok('documents:import', { paths: [app.file(`in/${name}`, `Inhalt von ${name}`)] });
  await app.services.jobs.whenIdle();
  return imp.imported[0]!.id;
}

const archiveRequest = (documentId: string) => ({
  items: [{ documentId, mode: 'copy', categoryPath: 'Arbeit/notes', topic: null }],
  confirmed: true,
  approveNewCategories: [],
  confirmMove: false,
});

describe('Quitting during an archive operation', () => {
  it('waits for the running archiving and refuses new ones', async () => {
    const id = await imported('laufend.txt');
    const other = await imported('danach.txt');
    vi.spyOn(fsp, 'copyFile').mockImplementation(async (src, dest, mode) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return realCopyFile(src, dest, mode);
    });

    const running = app.ok('documents:archive', archiveRequest(id) as never);
    await vi.waitFor(() => expect(fsp.copyFile).toHaveBeenCalled());
    const shutdown = app.services.shutdown({ archiveTimeoutMs: 5_000 });
    const refused = await app.services.archive
      .execute(archiveRequest(other).items as never, { confirmed: true, approveNewCategories: [], confirmMove: false })
      .catch((e: Error) => e);

    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/wird gerade beendet/);
    await expect(running).resolves.toMatchObject({ success: 1, failed: 0 });
    await shutdown;
  });

  it('gives up after the timeout and reports that operations were still running', async () => {
    const id = await imported('haengt.txt');
    let release: () => void = () => undefined;
    vi.spyOn(fsp, 'copyFile').mockImplementation(
      (src, dest, mode) => new Promise<void>((resolve) => (release = () => void realCopyFile(src, dest, mode).then(resolve))),
    );

    const running = app.services.archive.execute(archiveRequest(id).items as never, { confirmed: true, approveNewCategories: [], confirmMove: false });
    await vi.waitFor(() => expect(fsp.copyFile).toHaveBeenCalled());

    expect(await app.services.archive.drain(20)).toBe(false);

    release();
    await running;
    expect(await app.services.archive.drain(20)).toBe(true);
  });
});
