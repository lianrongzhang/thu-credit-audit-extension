// @ts-nocheck
import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
  downloadsDir: string;
}>({
  context: async ({ }, use) => {
    // Load the extension from the repository root (one level up from tests)
    const pathToExtension = path.join(__dirname, '..');
    const downloadsDir = path.join(__dirname, 'downloads');
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      acceptDownloads: true,
      downloadsPath: downloadsDir,
      args: [
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
      ],
    });
    await use(context);
    await context.close();
  },
  downloadsDir: async ({}, use) => {
    const downloadsDir = path.join(__dirname, 'downloads');
    await use(downloadsDir);
  },
  extensionId: async ({ context }, use) => {
    // for manifest v3:
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker)
      serviceWorker = await context.waitForEvent('serviceworker');

    const extensionId = serviceWorker.url().split('/')[2];
    await use(extensionId);
  },
});
export const expect = test.expect;