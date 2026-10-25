import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

// QA can use an installed browser without depending on a sibling VPS checkout.
export function launchBrowser(options = {}) {
  const settings = { headless: true, ...options };
  if (process.env.TEST_BROWSER_EXECUTABLE) {
    settings.executablePath = process.env.TEST_BROWSER_EXECUTABLE;
  } else if (process.env.TEST_BROWSER_CHANNEL) {
    settings.channel = process.env.TEST_BROWSER_CHANNEL;
  } else if (process.platform === 'win32') {
    settings.channel = 'msedge';
  }
  return chromium.launch(settings);
}
