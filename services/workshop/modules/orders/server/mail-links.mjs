import crypto from 'node:crypto';
import https from 'node:https';
import dns from 'node:dns';
import { BlockList } from 'node:net';
import { Parser } from 'htmlparser2';
import { inspectMedia, MediaError } from './media.mjs';

export const MAX_LAYOUT_BYTES = 64 * 1024 * 1024;
const problem = (code = 'MAIL_LINK_UNAVAILABLE') => new MediaError(code, 'Не удалось получить файл по ссылке Яндекс Диска. Проверка будет повторена.', 502);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function publicDiskUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !['yadi.sk', 'disk.yandex.ru', 'disk.yandex.com'].includes(url.hostname) || !/^\/d\/[A-Za-z0-9_-]{6,128}\/?$/.test(url.pathname)) return null;
    return `https://disk.yandex.ru${url.pathname.replace(/\/$/, '')}`;
  } catch { return null; }
}

// Parse HTML as inert data. Neither scripts, images nor arbitrary links are loaded.
export function diskLinks(html, text = '') {
  const found = new Map();
  let anchor;
  function add(url, label = '') {
    const canonical = publicDiskUrl(url);
    if (!canonical || found.has(canonical)) return;
    if (found.size >= 49) throw problem('MAIL_LINK_LIMIT');
    const name = label.replace(/\s*\(\d+\)\s*$/, '').trim().slice(0, 1000);
    found.set(canonical, { provider: 'yandex-disk', url: canonical, name: name || 'Файл с Яндекс Диска' });
  }
  const parser = new Parser({
    onopentag(tag, attributes) { if (tag === 'a') anchor = { url: attributes.href, text: '' }; },
    ontext(value) { if (anchor) anchor.text = (anchor.text + value).slice(0, 1100); },
    onclosetag(tag) { if (tag === 'a' && anchor) { add(anchor.url, anchor.text); anchor = null; } },
  }, { decodeEntities: true });
  parser.end(String(html || ''));
  for (const match of String(text).matchAll(/https:\/\/[^\s<>"']+/g)) add(match[0].replace(/[),.;]+$/, ''));
  return [...found.values()];
}

const privateNetworks = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) privateNetworks.addSubnet(ip, prefix);
for (const [ip, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) privateNetworks.addSubnet(ip, prefix, 'ipv6');
export const publicAddress = item => !privateNetworks.check(item.address, item.family === 6 ? 'ipv6' : 'ipv4');

export function allowedDownloadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (/^downloader\.disk\.yandex\.(ru|com)$/.test(url.hostname) || /^[a-z0-9-]+\.storage\.yandex\.net$/.test(url.hostname));
  } catch { return false; }
}

// The actual socket uses the validated DNS answer; every redirect is checked anew.
export function diskRequest(url, { maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal, headers: { 'Accept-Encoding': 'identity' }, lookup(host, options, callback) {
      dns.lookup(host, { all: true }, (error, addresses) => {
        if (error) return callback(problem());
        if (!addresses.length || !addresses.every(publicAddress)) return callback(problem('MAIL_LINK_HOST'));
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      });
    } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy(); resolve({ redirect: response.headers.location }); return;
      }
      if (response.statusCode !== 200) { response.destroy(); reject(problem()); return; }
      if (Number(response.headers['content-length']) > maxBytes) { response.destroy(); reject(problem('MAIL_LINK_SIZE')); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { response.destroy(); reject(problem('MAIL_LINK_SIZE')); }
        else chunks.push(chunk);
      });
      response.on('end', () => resolve({ bytes: Buffer.concat(chunks) }));
      response.on('error', () => reject(problem()));
    });
    request.on('error', () => reject(problem()));
  });
}

export class DiskAttachmentSource {
  constructor({ request = diskRequest } = {}) { this.request = request; }
  async download(link) {
    const publicKey = publicDiskUrl(link.url);
    if (!publicKey) throw problem('MAIL_LINK_HOST');
    const signal = AbortSignal.timeout(90_000);
    const api = async suffix => {
      const url = new URL(`https://cloud-api.yandex.net/v1/disk/public/resources${suffix}`);
      url.searchParams.set('public_key', publicKey);
      const response = await this.request(url, { maxBytes: 64 * 1024, signal });
      if (!response.bytes || response.bytes.length > 64 * 1024) throw problem();
      try { return JSON.parse(response.bytes.toString('utf8')); } catch { throw problem(); }
    };
    const metadata = await api('');
    const extension = String(metadata.name || '').split('.').at(-1).toLowerCase();
    if (metadata.type !== 'file' || !['cdr', 'pdf'].includes(extension)) throw problem('MAIL_LINK_FORMAT');
    const limit = extension === 'cdr' ? MAX_LAYOUT_BYTES : 12 * 1024 * 1024;
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > limit) throw problem('MAIL_LINK_SIZE');
    if (typeof metadata.name !== 'string' || metadata.name.length > 1000 || !/^[a-f0-9]{64}$/i.test(metadata.sha256)) throw problem('MAIL_LINK_METADATA');
    const download = await api('/download');
    let target = download.href;
    for (let redirect = 0; redirect <= 3; redirect++) {
      if (!allowedDownloadUrl(target)) throw problem('MAIL_LINK_HOST');
      const response = await this.request(new URL(target), { maxBytes: metadata.size, signal });
      if (response.redirect) { target = new URL(response.redirect, target).href; continue; }
      const bytes = response.bytes;
      if (!Buffer.isBuffer(bytes) || bytes.length !== metadata.size || sha(bytes) !== metadata.sha256.toLowerCase()) throw problem('MAIL_LINK_CHANGED');
      const contentType = extension === 'cdr' ? 'application/vnd.corel-draw' : 'application/pdf';
      inspectMedia(bytes, contentType);
      return { name: metadata.name, size: bytes.length, contentType, bytes, contentHash: sha(bytes), publicUrl: publicKey };
    }
    throw problem('MAIL_LINK_REDIRECT');
  }
}
