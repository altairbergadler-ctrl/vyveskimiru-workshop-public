import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Private staging keeps transfer size independent of heap size. Callers always
// dispose their own directory, including disconnects and rejected transactions.
const cleaned = new Set();
export async function stageFile(
  write,
  directory = path.join(os.tmpdir(), 'workshop-transfers'),
) {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!cleaned.has(directory)) {
    cleaned.add(directory);
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !/^workshop-transfer-[a-zA-Z0-9]+$/.test(entry.name)
      )
        continue;
      const target = path.join(directory, entry.name),
        stat = await fsp.lstat(target);
      if (Date.now() - stat.mtimeMs > 86400000)
        await fsp.rm(target, { recursive: true, force: true });
    }
  }
  const folder = await fsp.mkdtemp(path.join(directory, 'workshop-transfer-'));
  const target = path.join(folder, 'body');
  const dispose = () => fsp.rm(folder, { recursive: true, force: true });
  try {
    await write(target);
    const handle = await fsp.open(target, 'r+');
    let stat, prefix;
    try {
      stat = await handle.stat();
      prefix = Buffer.alloc(Math.min(stat.size, 32));
      await handle.read(prefix, 0, prefix.length, 0);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!stat.size || !stat.isFile()) throw new Error('Empty file');
    return { path: target, size: stat.size, prefix, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function stageUpload(readable, directory) {
  const hash = crypto.createHash('sha256');
  const file = await stageFile(
    (target) =>
      pipeline(
        readable,
        new Transform({
          transform(chunk, _encoding, done) {
            hash.update(chunk);
            done(null, chunk);
          },
        }),
        fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }),
      ),
    directory,
  );
  return { ...file, hash: hash.digest('hex') };
}

export async function sendFile(
  request,
  response,
  file,
  { inline = false } = {},
) {
  try {
    const size = file.size ?? file.bytes.length;
    const headers = {
      'Content-Type': file.mime,
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(String(file.name || 'attachment').toWellFormed()).replaceAll("'", '%27')}`,
      'Accept-Ranges': 'bytes',
    };
    let start = 0,
      end = size - 1,
      status = 200;
    if (request.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      start = range?.[1]
        ? Number(range[1])
        : Math.max(0, size - Number(range?.[2] || 0));
      end =
        range?.[1] && range[2]
          ? Math.min(Number(range[2]), size - 1)
          : size - 1;
      if (
        !range ||
        (!range[1] && !range[2]) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      ) {
        response.writeHead(416, {
          ...headers,
          'Content-Range': `bytes */${size}`,
        });
        response.end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    response.writeHead(status, {
      ...headers,
      'Content-Length': end - start + 1,
    });
    if (request.method === 'HEAD') response.end();
    else if (file.path)
      await pipeline(fs.createReadStream(file.path, { start, end }), response);
    else response.end(file.bytes.subarray(start, end + 1));
  } finally {
    await file.dispose?.();
  }
}
