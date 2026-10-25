import fs from 'node:fs';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { maxApi } from './max-bot.mjs';
import { imageType, RETOUCH_MAX_BYTES } from './max-retouch-provider.mjs';

const failure = code => Object.assign(new Error(code), { code });
export function maxMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('MAX_MEDIA_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !['oneme.ru', 'okcdn.ru', 'mycdn.me', 'max.ru'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) throw failure('MAX_MEDIA_URL');
  return url;
}
export function publicMediaAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(c)) || (b === 88 && c === 99)))
      || (a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  return net.isIP(address) === 6 && /^[23]/u.test(address) && !/^2001:db8:/iu.test(address);
}
export async function sourceMediaRequest(config, value, { validateUrl, method = 'GET', bytes = null, contentType = null,
  limit = RETOUCH_MAX_BYTES, destination = null, signal, redirects = 0, lookup = dns.lookup, requestImpl = https.request } = {}) {
  const url = validateUrl(value), addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicMediaAddress(item.address))) throw failure('MAX_MEDIA_ADDRESS');
  const address = addresses.find(item => item.family === 4) || addresses[0];
  const response = await new Promise((resolve, reject) => {
    const request = requestImpl(url, { method, ca: config?.caFile ? [...tls.rootCertificates, fs.readFileSync(config.caFile)] : undefined, signal,
      lookup: (_, options, callback) => options?.all ? callback(null, [address]) : callback(null, address.address, address.family),
      headers: bytes ? { 'Content-Type': contentType, 'Content-Length': bytes.length } : {} }, incoming => {
      // Even rejected/redirected responses can emit a late connection error.
      incoming.on('error', () => reject(failure('MAX_MEDIA_READ')));
      if ([301, 302, 303, 307, 308].includes(incoming.statusCode)) {
        incoming.destroy(); resolve({ redirect: incoming.headers.location }); return;
      }
      if (incoming.statusCode !== 200 || Number(incoming.headers['content-length']) > limit) {
        incoming.destroy(); reject(failure('MAX_MEDIA_READ')); return;
      }
      if (destination) { pipeline(incoming,fs.createWriteStream(destination,{flags:'wx',mode:0o600})).then(()=>resolve({path:destination}),()=>reject(failure('MAX_MEDIA_READ')));return; }
      const chunks = []; let size = 0;
      incoming.on('data', chunk => { size += chunk.length; if (size > limit) incoming.destroy(failure('MAX_MEDIA_SIZE')); else chunks.push(chunk); });
      incoming.on('end', () => resolve({ bytes: Buffer.concat(chunks) }));
    });
    const timer = destination ? null : setTimeout(() => request.destroy(failure('MAX_MEDIA_TIMEOUT')), 30000);
    if(destination) request.setTimeout(60000,()=>request.destroy(failure('MAX_MEDIA_TIMEOUT')));
    request.on('close', () => clearTimeout(timer));
    request.on('error', () => reject(failure('MAX_MEDIA_READ')));
    request.end(bytes);
  });
  if (response.redirect) {
    // Never forward an uploaded image to a redirected URL. Download redirects are revalidated.
    if (method !== 'GET' || redirects >= 3) throw failure('MAX_MEDIA_REDIRECT');
    return sourceMediaRequest(config, new URL(response.redirect, url).href, { validateUrl, method, signal, redirects: redirects + 1, limit, destination, lookup, requestImpl });
  }
  return destination ? response : response.bytes;
}
export function maxMediaRequest(config, value, options = {}) {
  return sourceMediaRequest(config, value, { ...options, validateUrl: maxMediaUrl });
}
export async function downloadMaxImage(config, url, options) {
  const bytes = await maxMediaRequest(config, url, options); imageType(bytes); return bytes;
}
export async function uploadMaxImage(config, bytes, { api = maxApi, request = maxMediaRequest } = {}) {
  if (!bytes.length || bytes.length > RETOUCH_MAX_BYTES) throw failure('MAX_MEDIA_SIZE');
  const type = imageType(bytes);
  let upload;
  try { upload = await api(config, '/uploads?type=image', {}); }
  catch { throw failure('MAX_MEDIA_UPLOAD'); }
  maxMediaUrl(upload.url);
  const boundary = `workshop-${crypto.randomBytes(16).toString('hex')}`;
  const extension = type === 'image/jpeg' ? 'jpg' : type === 'image/webp' ? 'webp' : 'png';
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="retouch.${extension}"\r\nContent-Type: ${type}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const raw = await request(config, upload.url, { method: 'POST', bytes: body, contentType: `multipart/form-data; boundary=${boundary}`, limit: 256 * 1024 });
  let result;
  try { result = JSON.parse(raw.toString('utf8')); } catch { throw failure('MAX_MEDIA_UPLOAD'); }
  const tokens = Object.values(result.photos || {}).map(value => value?.token).filter(value => typeof value === 'string' && value.length > 0);
  if (tokens.length !== 1) throw failure('MAX_MEDIA_UPLOAD');
  return tokens[0];
}
