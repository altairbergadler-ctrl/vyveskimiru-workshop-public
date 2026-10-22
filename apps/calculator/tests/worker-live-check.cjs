const {chromium} = require('C:/Users/arhan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert = require('node:assert/strict');

// A fresh, isolated context exercises an existing root PWA worker without opening
// the workshop UI. Only public shell assets and calculator files may reach the
// network; business API requests are aborted and fail the test.
(async () => {
  const origin = 'https://vm-app.ru';
  const syntheticPath = '/__calculator_qa_scope';
  const browser = await chromium.launch({headless: true, channel: 'msedge'});
  const context = await browser.newContext({viewport: {width: 390, height: 844}, serviceWorkers: 'allow'});
  const blocked = [];
  const errors = [];
  const requests = [];
  context.on('request', request => requests.push({method: request.method(), url: request.url()}));
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname === syntheticPath && request.method() === 'GET') {
      await route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><meta charset="utf-8"><title>Calculator worker scope QA</title><body>Isolated public worker scope check.</body></html>'});
      return;
    }
    const businessPath = /(?:^|\/)(?:api|rpc|graphql|auth)(?:\/|$)/i.test(url.pathname);
    const publicPath = url.pathname === '/' || url.pathname === '/sw.js' || url.pathname.startsWith('/calculator/') || /\.(?:html?|js|mjs|css|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|json|webmanifest)$/i.test(url.pathname);
    if (request.method() !== 'GET' || url.origin !== origin || businessPath || !publicPath) {
      blocked.push({method: request.method(), url: request.url()});
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  // An explicit page route keeps the initial synthetic document independent of
  // any app shell; context routing also covers worker-owned public requests.
  await page.route(`${origin}${syntheticPath}`, route => route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><meta charset="utf-8"><title>Calculator worker scope QA</title><body>Isolated public worker scope check.</body></html>'}));
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${origin}${syntheticPath}`);
    await page.evaluate(() => navigator.serviceWorker.register('/sw.js', {scope: '/'}));
    await page.waitForFunction(() => navigator.serviceWorker.controller && new URL(navigator.serviceWorker.controller.scriptURL).pathname === '/sw.js', null, {timeout: 45000});
    const root = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/');
      return {scope: registration.scope, activeState: registration.active.state, controller: navigator.serviceWorker.controller.scriptURL};
    });
    assert.equal(root.scope, `${origin}/`);
    assert.equal(root.activeState, 'activated');
    assert.equal(new URL(root.controller).pathname, '/sw.js');
    assert.deepEqual(blocked, [], 'Only public shell resources may be requested during root worker installation.');

    await page.goto(`${origin}/calculator/`);
    await page.waitForSelector('#text-0');
    const numericTotal = async () => (await page.locator('#total-min').innerText()).replace(/[^\d,]/g, '');
    assert.equal(await numericTotal(), '27440');
    assert.equal(await page.locator('#count-0').inputValue(), '8');
    await page.waitForFunction(() => navigator.serviceWorker.controller && new URL(navigator.serviceWorker.controller.scriptURL).pathname === '/calculator/sw.js', null, {timeout: 45000});
    const scoped = await page.evaluate(async () => ({
      controller: navigator.serviceWorker.controller.scriptURL,
      registrations: (await navigator.serviceWorker.getRegistrations()).map(registration => ({scope: registration.scope, scriptURL: registration.active?.scriptURL, state: registration.active?.state})),
    }));
    assert.equal(new URL(scoped.controller).pathname, '/calculator/sw.js');
    assert.deepEqual(scoped.registrations.map(registration => registration.scope).sort(), [`${origin}/`, `${origin}/calculator/`].sort());
    assert.ok(scoped.registrations.every(registration => registration.state === 'activated'));
    await page.reload();
    await page.waitForSelector('#text-0');
    assert.equal(await numericTotal(), '27440');
    assert.equal(await page.locator('#count-0').inputValue(), '8');
    assert.equal(await page.evaluate(() => new URL(navigator.serviceWorker.controller.scriptURL).pathname), '/calculator/sw.js');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(blocked, [], 'No business API, external, or non-public request is permitted.');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({passed: true, root, scoped, reloaded: true, viewport: 390, errors, blocked, publicRequestCount: requests.length}));
  } finally {
    await context.close();
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
