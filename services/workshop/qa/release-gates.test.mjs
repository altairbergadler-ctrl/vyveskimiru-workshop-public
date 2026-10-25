import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../server/db.mjs';
import { FinanceSheetStore } from '../server/finance-sheet.mjs';
import { WarehouseReceipts } from '../server/warehouse-receipts.mjs';
import { createDirectory, removeDirectory } from './sandbox-lib.mjs';

const python = process.platform === 'win32' ? 'python' : 'python3';
function run(script, args) {
  const result = spawnSync(python, [script, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error; return result.status;
}
test('release gate blocks uncertain finance and order receipts and leaves confirmed data intact', () => {
  const directory = createDirectory('gate-'), data = path.join(directory, 'data'); fs.mkdirSync(data);
  const db = openDatabase(path.join(data, 'finance.sqlite3'));
  new FinanceSheetStore({ db, client: {} });
  try {
    assert.equal(run('deploy/check-commands.py', [data]), 0);
    db.prepare('INSERT INTO finance_commands VALUES(?,?,?,?,?,?,?,?)').run('qa', 'hash', 'create', 'qa', '{}', 'submitted', 'now', 'now');
    assert.notEqual(run('deploy/check-commands.py', [data]), 0);
    db.prepare("UPDATE finance_commands SET state='confirmed'").run();
    assert.equal(run('deploy/check-commands.py', [data]), 0);
    const receipts = path.join(data, 'orders', 'creation'); fs.mkdirSync(receipts, { recursive: true });
    const file = path.join(receipts, 'qa.json'); fs.writeFileSync(file, JSON.stringify({ state: 'reserved' }));
    assert.notEqual(run('deploy/check-commands.py', [data]), 0);
    fs.writeFileSync(file, JSON.stringify({ state: 'verified' }));
    assert.equal(run('deploy/check-commands.py', [data]), 0);
    assert.equal(db.prepare('SELECT state FROM finance_commands').get().state, 'confirmed');
    const warehouse = new WarehouseReceipts(db);
    warehouse.submit('qa-refill', {}, [], 2);
    assert.notEqual(run('deploy/check-commands.py', [data]), 0);
    warehouse.settle('qa-refill', 'confirmed');
    assert.equal(run('deploy/check-commands.py', [data]), 0);
    assert.equal(warehouse.get('qa-refill').state, 'confirmed');
    const target = path.join(directory, 'target'); fs.mkdirSync(path.join(target, 'server'), { recursive: true });
    assert.notEqual(run('deploy/check-commands.py', [data, target]), 0);
    const manifest = path.join(target, 'server', 'release-capabilities.json');
    fs.writeFileSync(manifest, JSON.stringify({ warehouseRefillReceipts: 1 }));
    assert.equal(run('deploy/check-commands.py', [data, target]), 0);
    fs.writeFileSync(manifest, JSON.stringify({ warehouseRefillReceipts: 0 }));
    assert.notEqual(run('deploy/check-commands.py', [data, target]), 0);
    fs.writeFileSync(manifest, JSON.stringify({ warehouseRefillReceipts: 1 }));
    db.exec("CREATE TABLE production_v2_commands(id TEXT,state TEXT); INSERT INTO production_v2_commands VALUES('qa','pending')");
    assert.notEqual(run('deploy/check-commands.py', [data]), 0);
    db.exec("UPDATE production_v2_commands SET state='confirmed'");
    assert.equal(run('deploy/check-commands.py', [data]), 0);
    assert.notEqual(run('deploy/check-commands.py', [data,target]), 0);
    fs.writeFileSync(manifest, JSON.stringify({warehouseRefillReceipts:1,productionV2:1}));
    assert.equal(run('deploy/check-commands.py', [data,target]), 0);
    db.prepare("UPDATE finance_commands SET input_json=?").run(JSON.stringify({type:'income',category:'Замеры'}));
    assert.notEqual(run('deploy/check-commands.py', [data,target]), 0);
    fs.writeFileSync(manifest, JSON.stringify({warehouseRefillReceipts:1,productionV2:1,measurementIncome:1}));
    assert.equal(run('deploy/check-commands.py', [data,target]), 0);
    const media = path.join(data, 'orders', 'media'); fs.mkdirSync(media);
    const index = path.join(media, 'index.json');
    for (const record of [{ contentType: 'application/vnd.corel-draw', deletedAt: 'now' }, { contentType: 'application/pdf', source: { key: 'source' } }]) {
      fs.writeFileSync(index, JSON.stringify({ records: [record] }));
      assert.notEqual(run('deploy/check-commands.py', [data,target]), 0);
    }
    fs.writeFileSync(manifest, JSON.stringify({warehouseRefillReceipts:1,productionV2:1,measurementIncome:1,mailCorelMedia:1}));
    assert.equal(run('deploy/check-commands.py', [data,target]), 0);
  } finally { db.close(); removeDirectory(directory); }
});

test('backup gate rejects missing, stale, wrong-release and corrupted backups', () => {
  const directory = createDirectory('backup-'), release = path.join(directory, 'release'); fs.mkdirSync(release);
  const db = openDatabase(path.join(directory, 'finance.sqlite3')); db.close();
  fs.writeFileSync(path.join(directory, 'google-full.json.gz'), gzipSync(JSON.stringify({ sheets: [{ properties: { title: 'Fictional' } }] })));
  fs.writeFileSync(path.join(directory, 'files.tar.gz'), gzipSync('fictional files'));
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), ['finance.sqlite3', 'google-full.json.gz', 'files.tar.gz'].map(name => crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex') + '  ' + name).join('\n'));
  const metadata = (date, revision = release) => fs.writeFileSync(path.join(directory, 'COMPLETE'), `started=${date}\nfinished=${date}\nrelease=${revision}\n`);
  try {
    assert.notEqual(run('deploy/check-backup.py', [directory, release]), 0);
    metadata('2000-01-01T00:00:00Z'); assert.notEqual(run('deploy/check-backup.py', [directory, release]), 0);
    metadata(new Date().toISOString(), directory); assert.notEqual(run('deploy/check-backup.py', [directory, release]), 0);
    metadata(new Date().toISOString()); assert.equal(run('deploy/check-backup.py', [directory, release]), 0);
    fs.appendFileSync(path.join(directory, 'COMPLETE'), 'analytics=present\n');
    assert.notEqual(run('deploy/check-backup.py', [directory, release]), 0);
    fs.copyFileSync(path.join(directory, 'finance.sqlite3'), path.join(directory, 'analytics.sqlite3'));
    fs.appendFileSync(path.join(directory, 'SHA256SUMS'), '\n' + crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, 'analytics.sqlite3'))).digest('hex') + '  analytics.sqlite3');
    assert.equal(run('deploy/check-backup.py', [directory, release]), 0);
    fs.appendFileSync(path.join(directory, 'COMPLETE'), 'sales=present\n');
    assert.notEqual(run('deploy/check-backup.py', [directory, release]), 0);
    fs.copyFileSync(path.join(directory, 'finance.sqlite3'), path.join(directory, 'sales.sqlite3'));
    fs.appendFileSync(path.join(directory, 'SHA256SUMS'), '\n' + crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, 'sales.sqlite3'))).digest('hex') + '  sales.sqlite3');
    assert.equal(run('deploy/check-backup.py', [directory, release]), 0);
    fs.appendFileSync(path.join(directory, 'files.tar.gz'), 'corruption'); assert.notEqual(run('deploy/check-backup.py', [directory, release]), 0);
  } finally { removeDirectory(directory); }
});
