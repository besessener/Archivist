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
    /** „Archivist denkt nach …“ while a request is running. */
    thinking: root.getByTestId('chat-loading'),
    sources: root.getByTestId('chat-source'),
    /** „Details“ next to a document source: opens the document page instead of the file (#174). */
    sourceDetails: root.getByTestId('chat-source-details'),
    /** In-app links in an answer (weekly review, agent answers). */
    appLinks: root.getByTestId('app-link'),
    conversationSelect: root.getByTestId('conversation-select'),
    /** „N von M“ note with „Mehr laden“ while only the newest messages of a long conversation are shown. */
    history: {
      capped: root.getByTestId('chat-history-capped'),
      loadMore: root.getByTestId('chat-history-load-more'),
    },
    /** Proposal cards below an answer; `data-status` holds the action's status. */
    actionCards: root.getByTestId('action-card'),
    toasts: page.getByTestId('toast'),
    /** Agent mode (#300): live steps of a running run, its summary below the answer and the mode switch. */
    agent: {
      steps: root.getByTestId('chat-loading').getByTestId('agent-step'),
      announcement: root.getByTestId('agent-live-announcement'),
      usage: root.getByTestId('agent-live-usage'),
      stop: root.getByTestId('chat-cancel'),
      summary: root.getByTestId('agent-run-summary'),
      details: root.getByTestId('agent-run-details'),
      undoRun: root.getByTestId('agent-undo-run'),
      undoConfirm: page.getByTestId('agent-undo-run-confirm'),
      undoResult: root.getByTestId('agent-undo-result'),
      quickReplies: root.getByTestId('chat-quick-reply'),
      mode: (mode: 'auto' | 'ask') => root.getByTestId(`agent-mode-${mode}`),
    },
    rename: {
      input: page.getByTestId('rename-input'),
      save: page.getByTestId('rename-save'),
    },
  };
  const interactions = {
    /** Sends a message and waits until it has been submitted. */
    send: async (text: string) => {
      await locators.inputs.message.fill(text);
      await locators.buttons.send.click();
    },
    lastReply: () => locators.messages.last(),
    /** „Bestätigen“ on the last proposal card. */
    approveLastAction: async () => {
      await locators.actionCards.last().getByTestId('action-approve').click();
    },
    /** Opens the technical details of a live step. */
    showStepDetails: async (index: number) => {
      await locators.agent.steps.nth(index).getByText('Technische Details').click();
    },
    undoLastRun: async () => {
      await locators.agent.undoRun.last().click();
      await locators.agent.undoConfirm.click();
    },
    inputHeight: () => locators.inputs.message.evaluate((element) => element.clientHeight),
    /** Drags the grip above the input field upwards (positive number = larger). */
    growInput: async (pixels: number) => {
      const grip = await locators.resizeHandle.boundingBox();
      if (!grip) throw new Error('The grip for enlarging the input field is not visible.');
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
  return pageObject({ root, locators, actions: interactions });
}
