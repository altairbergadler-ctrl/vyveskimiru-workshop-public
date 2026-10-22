import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { maxMediaRequest, publicMediaAddress } from './max-media.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-media-test-'));
  const caFile = path.join(directory, 'fictional-ca.pem'); fs.writeFileSync(caFile, 'fictional CA for fake transport');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return { caFile };
}
test('media DNS is checked before the connection and the chosen public address is pinned', async t => {
  const config = fixture(t); let connected = 0;
  await assert.rejects(maxMediaRequest(config, 'https://i.oneme.ru/photo', { lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    requestImpl: () => { connected++; throw new Error('must not connect'); } }), { code: 'MAX_MEDIA_ADDRESS' });
  assert.equal(connected, 0);
  const data = await maxMediaRequest(config, 'https://i.oneme.ru/photo', {
    lookup: async () => [{ address: '185.16.150.10', family: 4 }], requestImpl: (url, options, callback) => {
      assert.equal(url.hostname, 'i.oneme.ru'); assert.equal(options.headers.Authorization, undefined);
      options.lookup(url.hostname, { all: true }, (_, addresses) => assert.deepEqual(addresses, [{ address: '185.16.150.10', family: 4 }]));
      const req = new EventEmitter(); req.destroy = () => req.emit('error', new Error('test'));
      req.end = () => { const incoming = new PassThrough(); incoming.statusCode = 200; incoming.headers = { 'content-length': '3' };
        callback(incoming); incoming.end('abc'); queueMicrotask(() => req.emit('close')); }; return req;
    } });
  assert.equal(data.toString(), 'abc');
  assert.equal(publicMediaAddress('192.229.221.95'), true); assert.equal(publicMediaAddress('198.51.100.1'), false);
});
test('a MAX CDN redirect to an unapproved host is rejected and cannot forward an uploaded image', async t => {
  const config = fixture(t); let requests = 0;
  const requestImpl = (_, options, callback) => {
    requests++; const req = new EventEmitter(); req.end = () => { const incoming = new PassThrough(); incoming.statusCode = 302;
      incoming.headers = { location: 'https://attacker.example/photo' }; callback(incoming); incoming.end(); queueMicrotask(() => req.emit('close')); };
    return req;
  };
  const common = { lookup: async () => [{ address: '185.16.150.10', family: 4 }], requestImpl };
  await assert.rejects(maxMediaRequest(config, 'https://i.oneme.ru/photo', common), { code: 'MAX_MEDIA_URL' });
  await assert.rejects(maxMediaRequest(config, 'https://iu.oneme.ru/upload', { ...common, method: 'POST', bytes: Buffer.from('private photo') }), { code: 'MAX_MEDIA_REDIRECT' });
  assert.equal(requests, 2);
});

test('a late response reset after a CDN redirect is handled without crashing the backend', async t => {
  const config = fixture(t); let incoming;
  await assert.rejects(maxMediaRequest(config, 'https://i.oneme.ru/photo', {
    lookup: async () => [{ address: '185.16.150.10', family: 4 }],
    requestImpl: (_, options, callback) => {
      const req = new EventEmitter(); req.end = () => {
        incoming = new PassThrough(); incoming.statusCode = 302;
        incoming.headers = { location: 'https://attacker.example/photo' };
        callback(incoming); queueMicrotask(() => req.emit('close'));
      }; return req;
    },
  }), { code: 'MAX_MEDIA_URL' });
  assert.ok(incoming.listenerCount('error') > 0);
  incoming.emit('error', new Error('ECONNRESET'));
});
