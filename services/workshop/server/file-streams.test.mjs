import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { stageFile, stageUpload, sendFile } from './file-streams.mjs';
import { sourceMediaRequest } from './max-media.mjs';
import { avitoMediaUrl } from './sales-media.mjs';

test('provider media above 32 MiB streams to disk, serves an exact range and cleans temporary files', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-fixture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const chunk = Buffer.alloc(1024 * 1024, 65),
    size = 33 * chunk.length;
  const file = await stageFile(
    (target) =>
      sourceMediaRequest(null, 'https://files.avito.ru/fixture', {
        destination: target,
        limit: Infinity,
        validateUrl: avitoMediaUrl,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        requestImpl: (_url, _options, callback) => {
          const request = new EventEmitter();
          request.setTimeout = () => request;
          request.end = () =>
            queueMicrotask(() => {
              const incoming = Readable.from(
                (async function* () {
                  for (let i = 0; i < 33; i++) yield chunk;
                })(),
              );
              incoming.statusCode = 200;
              incoming.headers = { 'content-length': String(size) };
              callback(incoming);
            });
          return request;
        },
      }),
    directory,
  );
  assert.equal(file.size, size);
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  const server = http.createServer((request, response) => {
    void sendFile(request, response, {
      ...file,
      name: 'large.bin',
      mime: 'application/octet-stream',
    }).finally(finish);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch('http://127.0.0.1:' + server.address().port, {
    headers: { Range: 'bytes=1048576-1048607' },
  });
  assert.equal(response.status, 206);
  assert.equal(
    response.headers.get('content-range'),
    `bytes 1048576-1048607/${size}`,
  );
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    Buffer.alloc(32, 65),
  );
  await finished;
  assert.deepEqual(await fs.readdir(directory), []);
});
test('failed upload removes only its private temporary directory', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-failure-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'keep.txt'), 'fixture');
  await assert.rejects(
    stageUpload(
      Readable.from(
        (async function* () {
          yield Buffer.from('partial');
          throw new Error('Disconnected');
        })(),
      ),
      directory,
    ),
  );
  assert.deepEqual(await fs.readdir(directory), ['keep.txt']);
});

test('invalid Unicode and header failures always dispose a staged download', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-name-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const make = () =>
    stageFile(
      (target) => fs.writeFile(target, Buffer.from('fixture')),
      directory,
    );
  const file = await make();
  let disposition;
  await sendFile(
    { method: 'HEAD', headers: {} },
    {
      writeHead: (_status, headers) =>
        (disposition = headers['Content-Disposition']),
      end() {},
    },
    {
      ...file,
      name: ('a'.repeat(199) + '😀').slice(0, 200),
      mime: 'application/octet-stream',
    },
  );
  assert.match(disposition, /%EF%BF%BD/);
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(
    sendFile(
      { method: 'HEAD', headers: {} },
      {
        writeHead() {
          throw new Error('Headers rejected');
        },
      },
      { ...(await make()), name: 'safe.bin', mime: 'application/octet-stream' },
    ),
    /Headers rejected/,
  );
  assert.deepEqual(await fs.readdir(directory), []);
});
