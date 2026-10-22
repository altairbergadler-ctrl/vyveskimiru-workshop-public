import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export async function makePinHash(pin) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
}

export async function verifyPin(pin, encoded) {
  const [method, saltText, hashText] = String(encoded ?? '').split('$');
  if (method !== 'scrypt' || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64url');
  const actual = Buffer.from(await scrypt(pin, Buffer.from(saltText, 'base64url'), expected.length));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function sessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return [part, ''];
    return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}
