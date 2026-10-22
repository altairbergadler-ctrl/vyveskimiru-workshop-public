import fs from 'node:fs';
import path from 'node:path';

export const TEST_SHEET = 'EXAMPLE_TEST_GOOGLE_SHEET_ID_CHANGE_BEFORE_USE';
const protectedSheets = new Set(['EXAMPLE_PRODUCTION_GOOGLE_SHEET_ID_CHANGE_BEFORE_USE', 'EXAMPLE_BACKUP_GOOGLE_SHEET_ID_CHANGE_BEFORE_USE']);
export function assertTestSheet(id, confirmation) {
  if (!id || protectedSheets.has(id) || id !== TEST_SHEET || confirmation !== id) throw new Error('TEST_SHEET_NOT_ALLOWED');
  return id;
}
export function assertLoopback(base) {
  const url = new URL(base);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('TEST_URL_NOT_LOOPBACK');
  return url.origin;
}
export function assertOwned(directory) {
  const absolute = path.resolve(directory);
  if (fs.lstatSync(absolute).isSymbolicLink() || fs.readFileSync(path.join(absolute, '.workshop-qa'), 'utf8').trim() !== 'workshop-qa-v1') throw new Error('NOT_OWNED_QA_DIRECTORY');
  return absolute;
}
