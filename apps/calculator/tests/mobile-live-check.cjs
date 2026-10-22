const { chromium } = require('C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const baseUrl = process.env.BASE_URL || 'https://vm-app.ru/calculator/';
const outputDir = path.resolve(__dirname, '../output');
const viewports = [
  { width: 320, height: 844 },
  { width: 360, height: 844 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
  { width: 844, height: 390 },
];
const summary = {
  baseUrl,
  startedAt: new Date().toISOString(),
  browser: 'Edge headless',
  touch: true,
  realDeviceAcceptance: false,
  passed: false,
  viewports: [],
};

async function totals(page, min, max) {
  await page.waitForFunction(({ min, max }) => {
    const digits = selector => document.querySelector(selector)?.textContent.replace(/\D/g, '');
    return digits('#total-min') === String(min) && digits('#total-max') === String(max);
  }, { min, max });
  assert.equal(await page.locator('#copy').isEnabled(), true);
}

async function noHorizontalOverflow(page, stage) {
  const metrics = await page.evaluate(() => {
    const viewport = innerWidth;
    const overflowing = [...document.querySelectorAll('body *')]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.right > viewport + 1 || rect.left < -1);
      })
      .map(element => ({ tag: element.tagName, id: element.id, className: String(element.className) }))
      .slice(0, 12);
    return { viewport, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, overflowing };
  });
  assert.ok(metrics.document <= metrics.viewport && metrics.body <= metrics.viewport,
    `${stage}: horizontal overflow ${JSON.stringify(metrics)}`);
  return metrics;
}

async function invalid(page, selector) {
  assert.equal(await page.locator(selector).getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#copy').isDisabled(), true);
  assert.equal(await page.locator('#total-min').innerText(), 'Проверьте данные');
  assert.equal(await page.locator('#total-max').innerText(), '');
  assert.equal(await page.locator('#breakdown').innerText(), '');
}

async function checkViewport(browser, viewport) {
  const result = { ...viewport, passed: false, checks: [], errors: [], consoleErrors: [], badRequests: [], assets: [], screenshots: [] };
  let context;
  try {
    context = await browser.newContext({
      viewport,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => result.errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') result.consoleErrors.push(message.text());
    });
    page.on('requestfailed', request => result.badRequests.push({ url: request.url(), error: request.failure()?.errorText }));
    page.on('response', response => {
      const url = response.url();
      if (response.status() >= 400) result.badRequests.push({ url, status: response.status() });
      if (/\/(?:styles\.css|app\.mjs|calculator\.mjs)(?:\?|$)/.test(url)) {
        result.assets.push({ url, status: response.status(), contentType: response.headers()['content-type'] || '' });
      }
    });
    const response = await page.goto(baseUrl, { waitUntil: 'networkidle' });
    assert.ok(response && response.ok(), `Document status: ${response?.status()}`);
    await page.waitForFunction(() => document.querySelector('#letter-rows')?.children.length === 1);
    assert.equal(await page.locator('#count-0').inputValue(), '8');
    await totals(page, 27440, 31440);
    result.initialLayout = await noHorizontalOverflow(page, 'initial');
    assert.equal(await page.evaluate(() => navigator.maxTouchPoints > 0), true);
    result.checks.push('initial count 8, total 27440–31440, touch, no overflow');

    await page.locator('#text-0').fill(' \tАПТЕКА\u00a0 24\n ');
    assert.equal(await page.locator('#count-0').inputValue(), '8');
    await totals(page, 27440, 31440);
    result.checks.push('spaces, tabs, NBSP and newlines excluded');

    await page.locator('#text-0').fill('А'.repeat(240));
    assert.equal(await page.locator('#count-0').inputValue(), '240');
    result.longTextLayout = await noHorizontalOverflow(page, 'long text');
    const wrapping = await page.locator('#text-0').evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      wrap: element.wrap,
    }));
    assert.notEqual(wrapping.wrap, 'off');
    assert.ok(wrapping.scrollWidth <= wrapping.clientWidth + 2, `Textarea overflow: ${JSON.stringify(wrapping)}`);
    assert.ok(wrapping.scrollHeight > wrapping.clientHeight, 'Long text should wrap into multiple lines');
    const longScreenshot = path.join(outputDir, `mobile-live-${viewport.width}-long-text.png`);
    await page.screenshot({ path: longScreenshot, fullPage: true });
    result.screenshots.push(longScreenshot);
    result.checks.push('240-character text wraps without horizontal overflow');

    await page.locator('#text-0').fill('');
    await invalid(page, '#text-0');
    await page.locator('#text-0').pressSequentially('АПТЕКА 24', { delay: 15 });
    assert.equal(await page.locator('#count-0').inputValue(), '8');
    await totals(page, 27440, 31440);
    result.checks.push('typing in mobile viewport restores valid calculation');

    await page.locator('#cassette').check();
    await totals(page, 44240, 48240);
    await page.locator('#film').uncheck();
    await totals(page, 42800, 46800);
    await page.locator('#cassette').uncheck();
    await totals(page, 26000, 30000);
    await page.locator('#film').check();
    await totals(page, 27440, 31440);
    result.checks.push('all option combinations have expected totals');

    await page.locator('#text-0').fill('МИР');
    await page.locator('#height-0').fill('20');
    await page.locator('#add-group').click();
    await page.locator('#text-1').fill('24');
    await page.locator('#height-1').fill('60');
    await page.locator('#width').fill('300');
    await page.locator('#height').fill('60');
    await page.locator('#cassette').check();
    assert.equal(await page.locator('#count-0').inputValue(), '3');
    assert.equal(await page.locator('#count-1').inputValue(), '2');
    await totals(page, 49700, 53700);
    await noHorizontalOverflow(page, 'mixed groups');
    result.checks.push('mixed groups 3×20 cm + 2×60 cm: 49700–53700');

    await page.locator('#height').fill('59,99');
    await invalid(page, '#height');
    await page.locator('#height').fill('60');
    await totals(page, 49700, 53700);
    await page.locator('#text-1').fill(' \n\t\u00a0');
    assert.equal(await page.locator('#count-1').inputValue(), '0');
    await invalid(page, '#text-1');
    await page.locator('#text-1').fill('24');
    await totals(page, 49700, 53700);
    await page.locator('#width').fill('0');
    await invalid(page, '#width');
    await page.locator('#width').fill('300');
    await totals(page, 49700, 53700);
    result.checks.push('impossible height, empty text and zero width invalidate and recover');

    await page.locator('#copy').click();
    await page.waitForFunction(() => document.querySelector('#copy-status')?.textContent === 'Расчёт скопирован.');
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(clipboard.includes('Текст: МИР'));
    assert.ok(clipboard.includes('Текст: 24'));
    assert.ok(clipboard.replace(/\s/g, '').includes('Итого:от49700₽до53700₽'));
    result.clipboardReadVerified = true;
    result.checks.push('copy success and exact clipboard text verified');

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('#letter-rows')?.children.length === 1);
    assert.equal(await page.locator('#count-0').inputValue(), '8');
    assert.equal(await page.locator('#film').isChecked(), true);
    assert.equal(await page.locator('#cassette').isChecked(), false);
    await totals(page, 27440, 31440);
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await page.waitForFunction(() => scrollY === 0 && scrollX === 0);
    result.finalLayout = await noHorizontalOverflow(page, 'reload');
    const screenshot = path.join(outputDir, `mobile-live-${viewport.width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    result.screenshots.push(screenshot);
    result.checks.push('reload restores the initial example and layout');

    for (const filename of ['styles.css', 'app.mjs', 'calculator.mjs']) {
      const assets = result.assets.filter(asset => new URL(asset.url).pathname.endsWith(`/${filename}`));
      assert.ok(assets.length > 0, `Missing asset: ${filename}`);
      assert.ok(assets.every(asset => asset.status >= 200 && asset.status < 400), `Bad asset: ${filename}`);
      assert.ok(assets.every(asset => filename.endsWith('.css') ? /text\/css/i.test(asset.contentType) : /javascript/i.test(asset.contentType)),
        `Wrong content type: ${filename}`);
    }
    assert.deepEqual(result.errors, [], 'Uncaught browser errors');
    assert.deepEqual(result.consoleErrors, [], 'Console errors');
    assert.deepEqual(result.badRequests, [], 'Failed or HTTP error requests');
    result.checks.push('CSS and both modules loaded with correct MIME; no browser or network errors');
    result.passed = true;
  } catch (error) {
    result.failure = { message: error.message, stack: error.stack };
    if (context?.pages()[0]) {
      const screenshot = path.join(outputDir, `mobile-live-${viewport.width}-failure.png`);
      try {
        await context.pages()[0].screenshot({ path: screenshot, fullPage: true });
        result.screenshots.push(screenshot);
      } catch (captureError) {
        result.screenshotError = captureError.message;
      }
    }
  } finally {
    if (context) await context.close();
  }
  return result;
}

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    for (const viewport of viewports) {
      summary.viewports.push(await checkViewport(browser, viewport));
    }
    summary.passed = summary.viewports.every(result => result.passed);
  } finally {
    await browser.close();
  }
})().catch(error => {
  summary.failure = { message: error.message, stack: error.stack };
}).finally(() => {
  summary.finishedAt = new Date().toISOString();
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'mobile-live-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
  process.exitCode = summary.passed ? 0 : 1;
});
