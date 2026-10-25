import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { launchBrowser } from './browser-runtime.mjs';
import { createDirectory, removeDirectory, launch } from './sandbox-lib.mjs';
const directory = createDirectory('sales-browser-');
const output = path.resolve('work/validation/sales-browser');
fs.mkdirSync(output, { recursive: true });
let instance, browser;
const errors = [];
const results = [];
try {
  instance = await launch(directory);
  browser = await launchBrowser({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies([
    { name: 'finance_session', value: instance.token, url: instance.base },
    {
      name: 'sales_layout',
      value: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      url: instance.base,
    },
  ]);
  const post = async (action, data) => {
    const response = await context.request.post(
      instance.base + '/api/sales/command',
      { data: { requestId: crypto.randomUUID(), action, data } },
    );
    assert.equal(response.status(), 200, await response.text());
    return response.json();
  };
  let first;
  for (const [title, client, color, manual] of [
    [
      'Вывеска для кофейни',
      'Учебная кофейня «Мята»',
      'yellow',
      'Эскиз согласован. Нужен расчёт двух размеров.',
      'Отправить',
      'расчёт двух вариантов',
    ],
    [
      'Оформление витрины',
      'Учебный салон «Линия»',
      'green',
      'Ждём размеры витрины. Ответственный контролирует запрос.',
      'Уточнить',
      'размеры витрины',
    ],
    [
      'Таблички для кабинетов',
      'Учебная клиника «Город»',
      'blue',
      '18 табличек. Нужен список кабинетов и номера.',
      'Запросить',
      'список кабинетов',
    ],
    [
      'Новый баннер',
      'Учебная пекарня «Печь»',
      'lilac',
      'Дизайнер проверяет макет. Нужно получить итоговый файл.',
      'Получить',
      'согласованный макет',
    ],
  ]) {
    const n = await post('note.create', {
      title,
      client,
      color,
      manual,
      owner: 'Анна',
      status: 'active',
    });
    first ??= n;
  }
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(instance.base + '/sales/');
  await page.locator('.note').first().waitFor();
  assert.equal(await page.locator('.note').count(), 4);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.screenshot({
      path: path.join(output, `desk-${width}.png`),
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `overflow ${width}`,
    );
    results.push({
      width,
      overflow: false,
      notes: await page.locator('.note').count(),
    });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole('button', { name: 'Новая записка', exact: false })
    .click();
  await page
    .getByLabel('Название обращения', { exact: true })
    .fill('Тест повторного открытия');
  await page.getByLabel('Клиент / организация').fill('Вымышленный клиент');
  await page
    .getByLabel('Заметки менеджера')
    .fill('<script>throw new Error("unsafe")</script>');
  await page.locator('#editor-form button[type=submit]').click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.locator('#detail').waitFor();
  assert.match(await page.locator('#detail-body').textContent(), /script/);
  await page.screenshot({ path: path.join(output, 'detail-desktop.png') });
  await page
    .getByRole('button', { name: 'Закрыть детали', exact: true })
    .click();
  await page.reload();
  await page
    .getByRole('heading', { name: 'Тест повторного открытия', exact: true })
    .waitFor();
  results.push({ createAndReload: true, xssEscaped: true });
  await page.locator(`[data-note="${first.id}"] [data-open]`).click();
  assert.equal(
    await page
      .locator('[data-tab=tasks],[data-detail-action=task],[data-tab=history]')
      .count(),
    0,
  );
  const box = await page.locator('#detail').boundingBox();
  assert.ok(Math.abs(box.x + box.width / 2 - 720) < 2);
  assert.ok(Math.abs(box.y + box.height / 2 - 500) < 2);
  await page.locator('.detail-title').click();
  assert.equal(await page.locator('#detail').isVisible(), true);
  await page.mouse.click(5, 500);
  await page.locator('#detail').waitFor({ state: 'hidden' });
  await page.locator(`[data-note="${first.id}"] [data-open]`).click();
  results.push({
    centered: true,
    outsideClose: true,
    tasksAndHistoryRemoved: true,
  });
  await page.getByRole('button', { name: 'Файлы', exact: true }).click();
  await page
    .getByRole('button', { name: 'Прикрепить файл', exact: false })
    .click();
  await page.locator('#editor[open] input[type=file]').setInputFiles({
    name: 'fictional.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-test'),
  });
  await page.locator('#editor-form button[type=submit]').click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.getByRole('link', { name: 'fictional.pdf' }).waitFor();
  results.push({ fileUpload: true });
  await page
    .getByRole('button', { name: 'Прикрепить файл', exact: false })
    .click();
  const conflictedFile = {
    name: 'conflicted.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-conflict'),
  };
  await page
    .locator('#editor[open] input[type=file]')
    .setInputFiles(conflictedFile);
  const beforeFileConflict = await (
    await context.request.get(instance.base + '/api/sales/note?id=' + first.id)
  ).json();
  await post('note.update', {
    id: first.id,
    revision: beforeFileConflict.revision,
    patch: { manual: 'Уточнение во время загрузки' },
  });
  await page.locator('#editor-form button[type=submit]').click();
  await page
    .locator('#editor-error')
    .getByText('Данные уже изменились.', { exact: false })
    .waitFor();
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem('sales.pending')),
    null,
  );
  await page
    .getByRole('button', { name: 'Закрыть форму', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Закрыть детали', exact: true })
    .click();
  await page.locator('#review-drafts').click();
  await page.locator('[data-draft-review]').last().click();
  await page
    .locator('#editor[open] input[type=file]')
    .setInputFiles(conflictedFile);
  await page.route('**/api/sales/file', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort();
  });
  await page.locator('#editor-form button[type=submit]').click();
  await page.waitForFunction(
    () => document.getElementById('editor-error').textContent.length > 0,
  );
  await page.unroute('**/api/sales/file');
  await page.reload();
  await page.locator('#app:not([hidden])').waitFor();
  await page.locator('#retry-pending').click();
  await page.waitForFunction(() => !sessionStorage.getItem('sales.pending'));
  assert.deepEqual(
    await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem('sales.drafts') || '[]'),
    ),
    [],
  );
  const filesAfterRecovery = (
    await (
      await context.request.get(
        instance.base + '/api/sales/note?id=' + first.id,
      )
    ).json()
  ).files;
  assert.equal(
    filesAfterRecovery.filter((f) => f.name === 'conflicted.pdf').length,
    1,
  );
  await page
    .locator('[data-open="' + first.id + '"]')
    .first()
    .click();
  await page.getByRole('button', { name: 'Файлы', exact: true }).click();
  await page
    .getByRole('link', { name: 'conflicted.pdf', exact: true })
    .waitFor();
  results.push({ recoveredFileLostSuccessReconcilesDraft: true });
  results.push({ fileConflictDraftRecovery: true });
  await page.getByRole('button', { name: 'Обзор', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(output, 'detail-mobile.png'),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page
    .getByRole('button', { name: 'Изменить', exact: true })
    .first()
    .click();
  await page.getByLabel('Заметки менеджера').fill('Моя несохранённая правка');
  const current = await (
    await context.request.get(instance.base + '/api/sales/note?id=' + first.id)
  ).json();
  await post('note.update', {
    id: first.id,
    revision: current.revision,
    patch: { manual: 'Изменение другой вкладки' },
  });
  await page.locator('#editor-form button[type=submit]').click();
  await page
    .locator('#editor-error')
    .getByText('Данные уже изменились.', { exact: false })
    .waitFor();
  assert.equal(
    await page.getByLabel('Заметки менеджера').inputValue(),
    'Моя несохранённая правка',
  );
  results.push({ conflictPreservesDraft: true });
  await page.screenshot({
    path: path.join(output, 'conflict-mobile.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: 'Закрыть форму', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Закрыть детали', exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .locator('[data-open="' + first.id + '"]')
    .first()
    .click();
  await page
    .getByRole('button', { name: 'Изменить', exact: true })
    .first()
    .click();
  await page.getByLabel('Заметки менеджера').fill('Черновик после обрыва');
  let aborted = false;
  await page.route('**/api/sales/command', (route) => {
    if (!aborted) {
      aborted = true;
      return route.abort();
    }
    return route.continue();
  });
  await page.locator('#editor-form button[type=submit]').click();
  await page.waitForFunction(() => sessionStorage.getItem('sales.pending'));
  const latest = await (
    await context.request.get(instance.base + '/api/sales/note?id=' + first.id)
  ).json();
  await post('note.update', {
    id: first.id,
    revision: latest.revision,
    patch: { manual: 'Вторая вкладка после обрыва' },
  });
  await page
    .getByRole('button', { name: 'Закрыть форму', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Закрыть детали', exact: true })
    .click();
  await page.reload();
  await page.locator('#app:not([hidden])').waitFor();
  await page.locator('#retry-pending').click();
  await page.waitForFunction(() => !sessionStorage.getItem('sales.pending'));
  await page.locator('#review-drafts').click();
  await page.locator('[data-draft-review]').last().click();
  await page
    .locator('#editor-form')
    .getByText('Черновик после обрыва', { exact: false })
    .waitFor();
  await page
    .locator('#editor-form')
    .getByText('Вторая вкладка после обрыва', { exact: false })
    .waitFor();
  await page
    .getByRole('button', { name: 'Применить после сверки', exact: true })
    .click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  assert.equal(
    (
      await (
        await context.request.get(
          instance.base + '/api/sales/note?id=' + first.id,
        )
      ).json()
    ).manual,
    'Черновик после обрыва',
  );
  results.push({ draftSurvivesReloadAndReview: true });
  await page.locator('#new-note').click();
  await page
    .getByLabel('Название обращения', { exact: true })
    .fill('После восстановления');
  await page.locator('#editor-form button[type=submit]').click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page
    .getByRole('button', { name: 'Закрыть детали', exact: true })
    .click();
  results.push({ lostRequestConflictUnblocks: true });
  await page.unroute('**/api/sales/command');
  await page.getByRole('button', { name: 'Подключения', exact: false }).click();
  await page.screenshot({
    path: path.join(output, 'channels-mobile.png'),
    fullPage: true,
  });
  assert.match(await page.locator('#content').textContent(), /Telegram/);
  results.push({ unavailableChannelsVisible: true });
  await page
    .getByRole('button', {
      name: 'Выбрать глубину и включить приём',
      exact: true,
    })
    .click();
  assert.equal(
    await page.locator('#editor-form select[name=policy]').inputValue(),
    '',
  );
  assert.equal(
    (await (await context.request.get(instance.base + '/api/sales')).json())
      .channels[0].intake,
    false,
  );
  await page.locator('#editor-form select[name=policy]').selectOption('new');
  await page
    .getByRole('button', { name: 'Включить с выбранной глубиной', exact: true })
    .click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  assert.equal(
    (await (await context.request.get(instance.base + '/api/sales')).json())
      .channels[0].policy,
    'new',
  );
  results.push({ intakeNeedsExplicitChoice: true });

  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(output, 'result.json'),
    JSON.stringify({ results, errors }, null, 2),
  );
  console.log(JSON.stringify({ results, errors }));
} finally {
  await browser?.close();
  await instance?.stop();
  removeDirectory(directory);
}
