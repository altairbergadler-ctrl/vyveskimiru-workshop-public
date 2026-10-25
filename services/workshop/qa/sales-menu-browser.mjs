import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchBrowser } from './browser-runtime.mjs';
import { createDirectory, removeDirectory, launch } from './sandbox-lib.mjs';
const dir = createDirectory('sales-menus-'),
  output = path.resolve('work/validation/sales-menu');
fs.mkdirSync(output, { recursive: true });
let instance, browser;
const results = [],
  errors = [];
try {
  instance = await launch(dir, { production: true });
  browser = await launchBrowser({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  for (const width of [1440, 390]) {
    // A narrow viewport alone still sends mouse/hover events; use real touch
    // input for the phone's nested menu, where hover timers do not apply.
    const mobile = width < 600;
    const context = await browser.newContext({ hasTouch: mobile, isMobile: mobile });
    await context.addCookies([
      { name: 'finance_session', value: instance.token, url: instance.base },
    ]);
    for (const route of ['/', '/kanban/', '/production/']) {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      page.on('pageerror', (e) =>
        errors.push({ route, width, error: e.message }),
      );
      await page.goto(instance.base + route);
      await page.waitForLoadState('domcontentloaded');
      if (route === '/kanban/')
        await page.locator('#app:not([hidden])').waitFor();
      console.log(JSON.stringify({ checking: route, width }));
      await page
        .locator(
          'button[aria-label="Инструменты"]:visible,button[aria-label="Меню и ссылки"]:visible',
        )
        .first()
        .waitFor();
      const direct = page.getByRole('button', {
        name: 'Инструменты',
        exact: true,
      });
      if (await direct.isVisible()) await (mobile ? direct.tap() : direct.click());
      else {
        const menu = page.getByRole('button', { name: 'Меню и ссылки', exact: true });
        await (mobile ? menu.tap() : menu.click());
        const tools = page.getByRole('menuitem', { name: 'Инструменты', exact: true });
        await (mobile ? tools.tap() : tools.click());
      }
      const entry = page.getByRole('menuitem', {
        name: 'Рабочий стол продаж',
        exact: true,
      });
      await entry.waitFor();
      assert.equal(await entry.getAttribute('target'), '_blank');
      assert.equal(await entry.getAttribute('href'), '/sales/');
      const oldUrl = page.url();
      const [popup] = await Promise.all([
        page.waitForEvent('popup'),
        mobile ? entry.tap() : entry.click(),
      ]);
      await popup.locator('#app:not([hidden])').waitFor();
      assert.equal(new URL(popup.url()).pathname, '/sales/');
      assert.equal(page.url(), oldUrl);
      await popup.close();
      await page.screenshot({
        path: path.join(
          output,
          `menu-${route === '/' ? 'finance' : route.includes('kanban') ? 'orders' : 'production'}-${width}.png`,
        ),
      });
      results.push({ route, width, newTab: true, originalPreserved: true });
      await page.close();
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(output, 'result.json'),
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(JSON.stringify({ results, errors }));
} finally {
  await browser?.close();
  await instance?.stop();
  removeDirectory(dir);
}
