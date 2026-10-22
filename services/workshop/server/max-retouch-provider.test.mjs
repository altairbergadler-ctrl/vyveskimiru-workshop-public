import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runRetouch, retouchInput, retouchArguments } from './max-retouch-provider.mjs';
import { createBroker } from './max-codex-broker.mjs';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXs0AAAAASUVORK5CYII=', 'base64');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const input = () => ({ key: hash('fictional-photo-and-author'), instruction: 'Уберите провод. $(do-not-execute)', imageBase64: image.toString('base64'), imageSha256: hash(image) });
function fixture(t, mode = 'ok') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-retouch-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const threadId = '12345678-1234-1234-1234-123456789abc', imageRoot = path.join(root, 'generated');
  const generated = path.join(imageRoot, threadId); fs.mkdirSync(generated, { recursive: true });
  const file = path.join(generated, 'image.png'); fs.writeFileSync(file, image);
  let calls = 0, args, options, prompt;
  const spawnImpl = (_, argv, settings) => {
    calls++; args = argv; options = settings;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => child.emit('close', 137);
    child.stdin.on('data', chunk => { prompt = chunk.toString(); });
    child.stdin.on('finish', () => {
      if (mode === 'timeout') return;
      const events = [{ type: 'thread.started', thread_id: threadId },
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ imagePath: mode === 'outside' ? path.join(root, 'outside.png') : file }) } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }];
      if (mode === 'outside') fs.writeFileSync(path.join(root, 'outside.png'), image);
      child.stdout.end(events.map(value => JSON.stringify(value)).join('\n'));
      child.emit('close', mode === 'failed' ? 1 : 0);
    });
    return child;
  };
  return { options: { directory: path.join(root, 'jobs'), imageRoot, spawnImpl, timeoutMs: 30 }, calls: () => calls,
    capture: () => ({ args, options, prompt }) };
}
test('native subscription renderer uses stdin and restricted tools; duplicate, parallel and resumed requests reuse one durable result', async t => {
  const f = fixture(t), request = input();
  const [first, second] = await Promise.all([runRetouch(request, f.options), runRetouch(request, f.options)]);
  assert.equal(first.imageSha256, hash(image)); assert.equal(second.imageSha256, first.imageSha256);
  assert.equal((await runRetouch(request, f.options)).imageSha256, hash(image)); assert.equal(f.calls(), 1);
  const captured = f.capture();
  assert.ok(captured.args.includes('gpt-6-sol')); assert.ok(captured.args.includes('image_generation'));
  assert.ok(captured.args.includes('apps')); assert.ok(captured.args.includes('shell_tool')); assert.ok(captured.args.includes('unified_exec'));
  assert.equal(captured.options.env.OPENAI_API_KEY, undefined); assert.equal(captured.options.env.CODEX_API_KEY, undefined);
  assert.ok(captured.prompt.includes('$(do-not-execute)')); assert.ok(!captured.args.join(' ').includes('do-not-execute'));
  await assert.rejects(runRetouch({ ...request, instruction: 'different request' }, f.options), { code: 'RETOUCH_INPUT_CHANGED' }); assert.equal(f.calls(), 1);
});
test('an interrupted or unconfirmed generation is never generated twice after a new process request', async t => {
  for (const mode of ['failed','timeout','outside']) {
    const f = fixture(t, mode), request = input();
    await assert.rejects(runRetouch(request, f.options));
    await assert.rejects(runRetouch(request, f.options), { code: 'RETOUCH_PREVIOUS_UNCONFIRMED' });
    assert.equal(f.calls(), 1, mode);
  }
});
test('renderer rejects altered hashes, malformed base64, unsupported files and unsafe job keys before starting a child', () => {
  const valid = input(); assert.equal(retouchInput(valid).type, 'image/png');
  for (const changes of [{ key: '../escape' }, { imageSha256: hash('other') }, { imageBase64: '!' }, { instruction: '' },
    { imageBase64: Buffer.from('not-image').toString('base64'), imageSha256: hash('not-image') }]) assert.throws(() => retouchInput({ ...valid, ...changes }));
  assert.ok(retouchArguments('/job', '/job/input.png').includes('--ignore-user-config'));
});
test('image broker keeps authorization and validation, serializes images, and leaves the analytics/text lane available', async t => {
  let finish;
  const imageWait = new Promise(resolve => { finish = resolve; });
  const server = createBroker({ token: 'fictional', run: async () => ({ answer: 'analytics still works' }), retouch: async () => imageWait });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (route, payload, token = 'fictional') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method: 'POST', headers: { 'X-Workshop-Codex': token } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end(JSON.stringify(payload));
  });
  assert.equal((await call('/retouch', input(), 'bad')).status, 403);
  assert.equal((await call('/retouch', { key: '../wrong' })).status, 400);
  const first = call('/retouch', input()); await new Promise(resolve => setImmediate(resolve));
  const text = await call('/answer', { question: 'fictional', search: false }); assert.equal(text.status, 200); assert.equal(text.body.answer, 'analytics still works');
  assert.equal((await call('/retouch', input())).status, 429);
  finish({ imageBase64: image.toString('base64'), imageSha256: hash(image) }); assert.equal((await first).status, 200);
});
