import { unzipSync } from 'fflate';

// Container identification only: source documents are always downloaded, never rendered.
function riff(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || !/^CDR[0-9A-Z]$/.test(bytes.toString('ascii', 8, 12))) return false;
  return bytes.readUInt32LE(4) + 8 === bytes.length;
}

export function isCorelDocument(bytes) {
  if (riff(bytes)) return true;
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  let count = 0;
  let total = 0;
  let selected = 0;
  try {
    const entries = unzipSync(bytes, { filter(entry) {
      // Bitmap payloads stay compressed. Only the two bounded Corel headers below
      // are inflated; large declared image sizes do not allocate image buffers.
      if (++count > 2000 || (total += entry.originalSize) > 2 * 1024 * 1024 * 1024) throw new Error('Zip limits');
      if (!['content/riffData.cdr', 'content/root.dat'].includes(entry.name)) return false;
      if (++selected > 2 || entry.originalSize > 64 * 1024 * 1024) throw new Error('Corel limits');
      return true;
    } });
    return Object.values(entries).some(value => riff(Buffer.from(value)));
  } catch { return false; }
}

// Exact embedded raster, not an AI reconstruction or a render of active content.
export function corelThumbnail(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > 64 * 1024 * 1024 || bytes.readUInt32LE(0) !== 0x04034b50) return null;
  let count = 0, total = 0, selected = 0;
  try {
    const entries = unzipSync(bytes, { filter(entry) {
      if (++count > 2000 || (total += entry.originalSize) > 2 * 1024 * 1024 * 1024) throw new Error('Zip limits');
      if (entry.name !== 'previews/thumbnail.png') return false;
      if (++selected > 1 || entry.originalSize > 4 * 1024 * 1024) throw new Error('Preview limits');
      return true;
    } });
    return entries['previews/thumbnail.png'] ? Buffer.from(entries['previews/thumbnail.png']) : null;
  } catch { return null; }
}
