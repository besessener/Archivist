import { expect, type Page } from '@playwright/test';
import { pageObject } from './page-object';

export function initChat(page: Page) {
  const root = page.getByTestId('chat-page');
  const locators = {
    buttons: {
      send: root.getByTestId('chat-send'),
      rename: root.getByTestId('chat-rename'),
    },
    inputs: {
      message: root.getByTestId('chat-input'),
    },
    resizeHandle: root.getByTestId('chat-resize'),
    messages: root.getByTestId('chat-message'),
    sources: root.getByTestId('chat-source'),
    conversationSelect: root.getByTestId('conversation-select'),
    rename: {
      input: page.getByTestId('rename-input'),
      save: page.getByTestId('rename-save'),
    },
  };
  const interactions = {
    /** Schickt eine Nachricht und wartet, bis sie abgeschickt ist. */
    send: async (text: string) => {
      await locators.inputs.message.fill(text);
      await locators.buttons.send.click();
    },
    lastReply: () => locators.messages.last(),
    inputHeight: () => locators.inputs.message.evaluate((element) => element.clientHeight),
    /** Zieht den Griff über dem Eingabefeld nach oben (positive Zahl = größer). */
    growInput: async (pixels: number) => {
      const grip = await locators.resizeHandle.boundingBox();
      if (!grip) throw new Error('Der Griff zum Vergrößern des Eingabefelds ist nicht sichtbar.');
      const x = grip.x + grip.width / 2;
      await page.mouse.move(x, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, grip.y - pixels, { steps: 8 });
      await page.mouse.up();
    },
    resetInputHeight: async () => {
      await locators.resizeHandle.dblclick();
    },
    renameConversation: async (title: string) => {
      await locators.buttons.rename.click();
      await locators.rename.input.fill(title);
      await locators.rename.save.click();
      await expect(locators.conversationSelect).toContainText(title);
    },
  };
  return pageObject(root, locators, interactions);
}
