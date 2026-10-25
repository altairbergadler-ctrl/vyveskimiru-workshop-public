import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createDirectory, removeDirectory, launch } from './sandbox-lib.mjs';

test('sales HTTP uses owner auth, CSRF guard, durable receipts, shared existing order source and protected files', async () => {
  const dir = createDirectory('sales-http-');
  let instance;
  try {
    instance = await launch(dir);
    const base = instance.base;
    const cookie = `finance_session=${instance.token}; sales_layout=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    const read = async (path, auth = true) =>
      fetch(base + path, { headers: auth ? { cookie } : {} });
    assert.equal((await read('/api/sales', false)).status, 401);
    assert.equal((await read('/api/sales/media?partId=1', false)).status, 401);
    assert.equal(
      (await read('/api/sales/note-media?noteId=missing', false)).status,
      401,
    );
    assert.equal((await read('/api/sales?inboxCursor=invalid')).status, 400);
    const emptySearch = await (
      await read('/api/sales?inboxQuery=' + encodeURIComponent('Учебный поиск'))
    ).json();
    assert.equal(emptySearch.inboxPage.query, 'учебный поиск');
    assert.equal(emptySearch.inboxPage.total, 0);
    assert.equal((await read('/api/sales/file?id=missing', false)).status, 401);
    const publicPage = await read('/sales/', false);
    assert.equal(publicPage.status, 200);
    assert.match(await publicPage.text(), /Рабочий стол продаж/);
    const post = async (
      action,
      data,
      id = crypto.randomUUID(),
      origin = base,
    ) =>
      fetch(base + '/api/sales/command', {
        method: 'POST',
        headers: { cookie, origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: id, action, data }),
      });
    assert.equal(
      (
        await post(
          'note.create',
          { title: 'Подмена', owner: 'Тест' },
          crypto.randomUUID(),
          'https://evil.invalid',
        )
      ).status,
      403,
    );
    const requestId = crypto.randomUUID(),
      input = { title: 'Вымышленный запрос HTTP', owner: 'Тест' };
    const created = await post('note.create', input, requestId);
    assert.equal(created.status, 200);
    const note = await created.json();
    assert.equal(
      (await (await post('note.create', input, requestId)).json()).id,
      note.id,
    );
    const receipt = await (
      await read('/api/sales/receipt?id=' + requestId)
    ).json();
    assert.equal(receipt.found, true);
    const invalid = await post('note.update', {
      id: note.id,
      revision: note.revision,
      patch: { orderId: '999999999' },
    });
    assert.equal(invalid.status, 409);
    const taskResponse = await post('task.create', {
      noteId: note.id,
      revision: note.revision,
      patch: {
        action: 'Проверить',
        object: 'Вымышленный макет',
        owner: 'Тест',
      },
    });
    assert.equal(taskResponse.status, 410);
    const before = await (await read('/api/sales/note?id=' + note.id)).json();
    const file = await fetch(base + '/api/sales/file', {
      method: 'POST',
      headers: {
        cookie,
        origin: base,
        'Content-Type': 'application/pdf',
        'x-request-id': crypto.randomUUID(),
        'x-note-id': note.id,
        'x-note-revision': String(before.revision),
        'x-file-name': encodeURIComponent('макет.pdf'),
      },
      body: '%PDF-fixture',
    });
    assert.equal(file.status, 200);
    const saved = await file.json();
    const downloaded = await read('/api/sales/file?id=' + saved.id);
    assert.equal(await downloaded.text(), '%PDF-fixture');
    assert.match(downloaded.headers.get('content-disposition'), /^attachment/);
    assert.equal((await read('/api/health')).status, 200);
    const after = await (await read('/api/sales')).json();
    assert.equal(after.notes.length, 1);
    assert.equal(after.notes[0].fileCount, 1);
    assert.equal('openTasks' in after.notes[0], false);
    assert.equal(
      after.channels.find((c) => c.id === 'telegram').connected,
      false,
    );
    await instance.stop();
    instance = await launch(dir);
    const restored = await fetch(instance.base + '/api/sales', {
      headers: { cookie: `finance_session=${instance.token}` },
    });
    assert.equal((await restored.json()).notes[0].id, note.id);
  } finally {
    await instance?.stop();
    removeDirectory(dir);
  }
});

test('sales unavailable database leaves finance healthy and recovery exposes the intake gap', async () => {
  const dir = createDirectory('sales-failed-db-');
  let instance;
  try {
    const blocked = path.join(dir, 'data', 'sales.sqlite3');
    fs.mkdirSync(blocked, { recursive: true });
    instance = await launch(dir);
    const cookie = `finance_session=${instance.token}`;
    assert.equal((await fetch(instance.base + '/api/health')).status, 200);
    assert.equal(
      (await fetch(instance.base + '/api/sales', { headers: { cookie } }))
        .status,
      503,
    );
    await instance.stop();
    fs.rmdirSync(blocked);
    instance = await launch(dir);
    const result = await fetch(instance.base + '/api/sales', {
      headers: { cookie: `finance_session=${instance.token}` },
    });
    assert.equal(result.status, 200);
    assert.ok(
      (await result.json()).channels.find((c) => c.id === 'avito').gapAt,
    );
  } finally {
    await instance?.stop();
    removeDirectory(dir);
  }
});
