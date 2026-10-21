import fs from 'node:fs';
import path from 'node:path';
import { expectNoSeriousA11yViolations } from './axe';
import { expect, test } from './fixture';
import { writeTextImage } from './helpers';

/** Files and images attached in the chat: imported like any upload, answered in the chat, without leaving it. */
test.describe('chat: attachments', () => {
  test('attaches an image, sends it to the agent with the message and stays in the chat', async ({ llm, on, page, workspace }, testInfo) => {
    llm.agentTurns = [{ text: 'Auf dem Bild steht die Rechnung 4711.' }];
    await on(page).setup.do.complete(llm.url);
    const app = on(page);
    const photo = await writeTextImage({ dir: workspace.downloads, name: 'kassenzettel.png', lines: ['Rechnung 4711'] });
    const program = workspace.addDownload('programm.exe', 'MZ');

    await app.chat.do.attach([photo, program]);
    await expect(app.chat.locators.attachments.chips.first()).toHaveAttribute('data-state', 'ready');
    await expect(app.chat.locators.attachments.chips.last()).toHaveAttribute('data-state', 'rejected');
    await expect(app.chat.locators.attachments.chips.last()).toContainText('programm.exe');
    await expectNoSeriousA11yViolations(page, testInfo);
    await app.chat.locators.attachments.remove.last().click();
    await expect(app.chat.locators.attachments.chips).toHaveCount(1);
    await expect(app.inbox.locators.importCard).toBeHidden();

    await app.chat.locators.buttons.send.click();

    await expect(app.chat.locators.attachments.sent.last()).toContainText('kassenzettel.png');
    await expect(app.chat.do.lastReply()).toContainText('Rechnung 4711');
    await expect(app.chat.locators.attachments.chips).toHaveCount(0);
    expect(page.url()).toContain('/chat');
    const sent = JSON.stringify(llm.agentInputs.at(-1));
    expect(sent).toContain('data:image/jpeg;base64,');
    expect(sent).toContain('kassenzettel.png');

    await app.navigation.do.open('inbox');
    await expect(app.inbox.locators.items).toHaveCount(1);
    expect(fs.readdirSync(path.join(workspace.dataDir, 'inbox'))).toEqual(['kassenzettel.png']);
    expect(fs.existsSync(photo), 'the original is kept').toBe(true);
  });

  test('a picture pasted from the clipboard becomes an attachment; pasted text stays text', async ({ electronApp, llm, on, page, workspace }) => {
    llm.agentTurns = [{ text: 'Ich sehe den Screenshot.' }];
    await on(page).setup.do.complete(llm.url);
    const app = on(page);
    const screenshot = await writeTextImage({ dir: workspace.downloads, name: 'screenshot.png', lines: ['Fehler 42'] });
    const copy = (content: { file: string; text?: string }) =>
      electronApp.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, { file, text }) => {
        const png = new Blob([new Uint8Array(nativeImage.createFromPath(file).toPNG())], { type: 'image/png' });
        await clipboard.write([new ClipboardItem({ 'image/png': png, ...(text ? { 'text/plain': text } : {}) })]);
      }, content);
    await copy({ file: screenshot });

    await app.chat.do.paste();

    await expect(app.chat.locators.attachments.chips).toHaveAttribute('data-state', 'ready');
    await expect(app.chat.locators.attachments.chips).toContainText(/^Eingefügtes Bild \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.png$/);
    await expect(app.chat.locators.inputs.message).toHaveValue('');
    await app.chat.locators.buttons.send.click();
    await expect(app.chat.do.lastReply()).toContainText('Screenshot');
    expect(JSON.stringify(llm.agentInputs.at(-1))).toContain('data:image/jpeg;base64,');
    expect(fs.readdirSync(path.join(workspace.dataDir, 'inbox'))).toEqual([expect.stringMatching(/^Eingefügtes Bild .+\.png$/)]);

    await copy({ file: screenshot, text: 'Rechnung 4711' });
    await app.chat.do.paste();
    await expect(app.chat.locators.inputs.message).toHaveValue('Rechnung 4711');
    await expect(app.chat.locators.attachments.chips).toHaveCount(0);
  });
});
