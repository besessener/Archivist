import type { Page } from '@playwright/test';
import { initChat } from './chat';
import { initInbox } from './inbox';
import { initInsights } from './insights';
import { initNavigation } from './navigation';
import { initScan } from './scan';
import { initSettings } from './settings';
import { initSetupWizard } from './setup';
import { initTimeline } from './timeline';

/** Getter, damit ein Spec nur die Locators der Seiten aufbaut, die er braucht. */
export type PageTree = ReturnType<typeof createPageTree>;

export function createPageTree(page: Page) {
  return {
    get chat() {
      return initChat(page);
    },
    get inbox() {
      return initInbox(page);
    },
    get insights() {
      return initInsights(page);
    },
    get navigation() {
      return initNavigation(page);
    },
    get scan() {
      return initScan(page);
    },
    get settings() {
      return initSettings(page);
    },
    get setup() {
      return initSetupWizard(page);
    },
    get timeline() {
      return initTimeline(page);
    },
  };
}
