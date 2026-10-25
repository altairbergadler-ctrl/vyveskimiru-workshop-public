import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, renameSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { isCorelDocument, corelThumbnail } from './corel.mjs';
import { validDocumentLayout } from './document-layout.mjs';

const MIB = 1024 * 1024;
const ID = /^[a-f0-9]{32}$/;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TYPES = new Map([
  ['image/jpeg', ['jpg', 'jpeg']], ['image/png', ['png']],
  ['image/webp', ['webp']], ['image/gif', ['gif']], ['application/pdf', ['pdf']],
  ['application/vnd.corel-draw', ['cdr']],
]);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export class MediaError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function invalidFile() {
  return new MediaError('MEDIA_INVALID_FILE', 'Файл повреждён или имеет неподдерживаемый формат. Используйте JPG, PNG, WebP, GIF, PDF или CDR.', 415);
}

function validSource(source) {
  return source && /^[a-f0-9]{64}$/.test(source.key) && typeof source.from === 'string' && source.from.length <= 320 &&
    typeof source.messageId === 'string' && source.messageId.length <= 512 && /^\d{1,2}$/.test(source.partId) &&
    typeof source.subject === 'string' && source.subject.length <= 512 &&
    (source.sentAt === null || (typeof source.sentAt === 'string' && Number.isFinite(Date.parse(source.sentAt)))) &&
    (source.messageKey === undefined || /^[a-f0-9]{64}$/.test(source.messageKey)) &&
    (source.publicUrl === undefined || /^https:\/\/disk\.yandex\.ru\/d\/[A-Za-z0-9_-]{6,128}$/.test(source.publicUrl));
}

function validGenerated(value) {
  const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(key=>['documentId','type','number','version','requestId','snapshotHash','test','decoration'].includes(key)) &&
    uuid.test(value.documentId) && uuid.test(value.requestId) && ['invoice','upd'].includes(value.type) && typeof value.number==='string' && value.number.length>0 && value.number.length<=40 &&
    Number.isInteger(value.version) && value.version>0 && /^[a-f0-9]{64}$/.test(value.snapshotHash) && typeof value.test==='boolean' &&
    (value.decoration===undefined||validDecoration(value.decoration,uuid)&&value.decoration.operationId===value.requestId&&value.decoration.parentDocumentId!==value.documentId);
}

function validDecoration(value,uuid) {
  const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
  const sha=value=>/^[a-f0-9]{64}$/.test(value);
  const asset=value=>plain(value)&&Object.keys(value).length===2&&ID.test(value.id)&&sha(value.sha256);
  const box=value=>plain(value)&&Object.keys(value).length===5&&Number.isInteger(value.page)&&value.page>=0&&['x','y','width','height'].every(key=>Number.isFinite(value[key]))&&value.x>=0&&value.y>=0&&value.width>0&&value.height>0;
  return plain(value)&&Object.keys(value).length===14&&Object.keys(value).every(key=>['version','kind','parentDocumentId','operationId','jobId','resultId','sourceHash','engineRequestHash','stamp','signature','placement','signaturePlacement','profile','dpi'].includes(key))&&
    value.version===1&&['stamped','scan'].includes(value.kind)&&uuid.test(value.parentDocumentId)&&uuid.test(value.operationId)&&ID.test(value.jobId)&&ID.test(value.resultId)&&sha(value.sourceHash)&&sha(value.engineRequestHash)&&
    (value.stamp===null?value.placement===null:asset(value.stamp)&&box(value.placement))&&(value.signature===null?value.signaturePlacement===null:asset(value.signature)&&box(value.signaturePlacement))&&Boolean(value.stamp||value.signature)&&['light','standard','strong'].includes(value.profile)&&[150,200].includes(value.dpi);
}

function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 20_000 || height > 20_000 || width * height > 60_000_000) {
    throw new MediaError('MEDIA_IMAGE_DIMENSIONS', 'Изображение слишком большое. Максимум 60 мегапикселей и 20 000 пикселей по стороне.', 413);
  }
  return { width, height };
}

function pngDimensions(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG)) throw invalidFile();
  let offset = 8;
  let size;
  let imageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw invalidFile();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    let crc = 0xffffffff;
    for (let i = offset + 4; i < end - 4; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end - 4)) throw invalidFile();
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) throw invalidFile();
      size = dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
    } else if (type === 'IHDR') throw invalidFile();
    if (type === 'IDAT' && length) imageData = true;
    if (type === 'IEND') {
      if (length !== 0 || end !== bytes.length || !imageData) throw invalidFile();
      return size;
    }
    offset = end;
  }
  throw invalidFile();
}

function jpegDimensions(bytes) {
  if (bytes.length < 12 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw invalidFile();
  let offset = 2;
  let size;
  const frames = new Set([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207]);
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 255) throw invalidFile();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0 || marker === 216 || marker === 217 || offset + 2 > bytes.length) throw invalidFile();
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length - 2) throw invalidFile();
    if (frames.has(marker)) {
      if (length < 8) throw invalidFile();
      size = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    if (marker === 218) {
      if (!size || offset + length >= bytes.length - 2) throw invalidFile();
      return size;
    }
    offset += length;
  }
  throw invalidFile();
}

function webpDimensions(bytes) {
  if (bytes.length < 26 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalidFile();
  let offset = 12;
  let size;
  let imageData = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (data + length > bytes.length) throw invalidFile();
    if (type === 'VP8X') {
      if (length !== 10) throw invalidFile();
      size = dimensions(bytes.readUIntLE(data + 4, 3) + 1, bytes.readUIntLE(data + 7, 3) + 1);
    } else if (type === 'VP8 ') {
      if (length < 10 || !bytes.subarray(data + 3, data + 6).equals(Buffer.from([157, 1, 42]))) throw invalidFile();
      size ||= dimensions(bytes.readUInt16LE(data + 6) & 16383, bytes.readUInt16LE(data + 8) & 16383);
      imageData = true;
    } else if (type === 'VP8L') {
      if (length < 5 || bytes[data] !== 47) throw invalidFile();
      const packed = bytes.readUInt32LE(data + 1);
      if (packed >>> 29) throw invalidFile();
      size ||= dimensions((packed & 16383) + 1, ((packed >>> 14) & 16383) + 1);
      imageData = true;
    } else if (type === 'ANMF' && length >= 16) imageData = true;
    offset = data + length + (length % 2);
  }
  if (!size || !imageData || offset !== bytes.length) throw invalidFile();
  return size;
}

function gifDimensions(bytes) {
  if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) throw invalidFile();
  const size = dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  let offset = 13 + (bytes[10] & 128 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0);
  let frames = 0;
  function blocks() {
    let length;
    do {
      if (offset >= bytes.length) throw invalidFile();
      length = bytes[offset++];
      offset += length;
      if (offset > bytes.length) throw invalidFile();
    } while (length);
  }
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 59) {
      if (!frames || offset !== bytes.length) throw invalidFile();
      return size;
    }
    if (marker === 33) {
      offset++;
      blocks();
    } else if (marker === 44) {
      if (offset + 9 > bytes.length || ++frames > 300) throw invalidFile();
      dimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6));
      const packed = bytes[offset + 8];
      offset += 9 + (packed & 128 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      if (bytes[offset] < 2 || bytes[offset] > 8) throw invalidFile();
      offset++;
      blocks();
    } else throw invalidFile();
  }
  throw invalidFile();
}

export function inspectMedia(bytes, declaredType) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw invalidFile();
  let contentType;
  let size;
  if (bytes.subarray(0, 8).equals(PNG)) { contentType = 'image/png'; size = pngDimensions(bytes); }
  else if (bytes[0] === 255 && bytes[1] === 216) { contentType = 'image/jpeg'; size = jpegDimensions(bytes); }
  else if (isCorelDocument(bytes)) { contentType = 'application/vnd.corel-draw'; }
  else if (bytes.toString('ascii', 0, 4) === 'RIFF') { contentType = 'image/webp'; size = webpDimensions(bytes); }
  else if (bytes.toString('ascii', 0, 3) === 'GIF') { contentType = 'image/gif'; size = gifDimensions(bytes); }
  else if (/^%PDF-(?:1\.[0-7]|2\.0)[\s]/.test(bytes.toString('latin1', 0, 16))) {
    if (!/%%EOF[\x00\t\n\f\r ]*$/.test(bytes.subarray(-2048).toString('latin1'))) throw invalidFile();
    contentType = 'application/pdf';
  } else throw invalidFile();
  if (String(declaredType || '').split(';')[0].trim().toLowerCase() !== contentType) {
    throw new MediaError('MEDIA_TYPE_MISMATCH', 'Содержимое файла не соответствует указанному типу.', 415);
  }
  return { contentType, kind: contentType.startsWith('image/') ? 'image' : 'document', ...size };
}

function safeName(input, contentType) {
  if (typeof input !== 'string' || input.length > 1000) throw new MediaError('MEDIA_INVALID_NAME', 'Проверьте имя файла.');
  let name = input.normalize('NFC').split(/[\\/]/u).at(-1).replace(/[\p{Cc}\p{Cf}<>:"|?*]/gu, '_').trim().replace(/[. ]+$/u, '');
  if (!name || /^\.+$/u.test(name)) name = 'Файл';
  const extension = path.extname(name).slice(1).toLowerCase();
  const allowed = TYPES.get(contentType);
  if (extension && !allowed.includes(extension)) throw new MediaError('MEDIA_EXTENSION_MISMATCH', 'Расширение файла не соответствует его содержимому.', 415);
  const suffix = `.${extension || allowed[0]}`;
  const stem = extension ? name.slice(0, -suffix.length) : name;
  return `${[...stem].slice(0, 160).join('')}${suffix}`;
}

function attachmentName(input) {
  if(typeof input!=='string' || input.length>1000) throw new MediaError('MEDIA_INVALID_NAME','Проверьте имя файла.');
  return input.normalize('NFC').split(/[\\/]/u).at(-1).replace(/[\p{Cc}\p{Cf}<>:"|?*]/gu,'_').trim().replace(/[. ]+$/u,'').slice(0,200) || 'Вложение';
}
function orderKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new MediaError('MEDIA_INVALID_ORDER', 'Некорректный номер заказа.');
  }
  return value.trim();
}

async function atomicWrite(target, bytes, beforeCommit) {
  const temporary = `${target}.${crypto.randomBytes(8).toString('hex')}.part`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (beforeCommit) { beforeCommit(); renameSync(temporary, target); }
    else await fs.rename(temporary, target);
    if (process.platform !== 'win32') {
      // Sync the containing directory where the filesystem supports directory fsync.
      let directory;
      try { directory = await fs.open(path.dirname(target), 'r'); await directory.sync(); }
      catch { /* The file and atomic rename have already completed. */ }
      finally { await directory?.close(); }
    }
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch(() => undefined);
  }
}

/** One process owns this private directory. Deletions are reversible tombstones. */
export class MediaStore {
  constructor({ directory, maxFileBytes = 64 * MIB, maxOrderBytes = 200 * MIB, maxTotalBytes = 512 * MIB, maxFilesPerOrder = 30, maxTotalFiles = 1000 } = {}) {
    if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('Media storage directory is required');
    for (const limit of [maxFileBytes, maxOrderBytes, maxTotalBytes, maxFilesPerOrder, maxTotalFiles]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Media storage limits must be positive integers');
    }
    this.directory = path.resolve(directory);
    this.blobs = path.join(this.directory, 'blobs');
    this.indexPath = path.join(this.directory, 'index.json');
    Object.assign(this, { maxFileBytes, maxOrderBytes, maxTotalBytes, maxFilesPerOrder, maxTotalFiles });
    this.state = { version: 1, records: [] };
    this.attachments = [];
    this.attachmentsPath = path.join(this.directory, 'attachments.json');
    this.totalBytes = 0;
    this.totalFiles = 0;
    this.ready = null;
    this.writes = Promise.resolve();
  }

  async guard(action) {
    try { return await action(); }
    catch (error) {
      if (error instanceof MediaError) throw error;
      throw new MediaError('MEDIA_STORAGE_UNAVAILABLE', 'Хранилище файлов временно недоступно. Повторите попытку.', 503);
    }
  }

  init() {
    if (!this.ready) this.ready = this.guard(async () => {
      await fs.mkdir(this.blobs, { recursive: true, mode: 0o700 });
      await fs.chmod(this.directory, 0o700);
      await fs.chmod(this.blobs, 0o700);
      let content;
      try {
        const stat = await fs.lstat(this.indexPath);
        if (!stat.isFile() || stat.size > 4 * MIB) throw new Error('Invalid media index');
        content = await fs.readFile(this.indexPath, 'utf8');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (content !== undefined) {
        const state = JSON.parse(content);
        if (state.version !== 1 || !Array.isArray(state.records) || state.records.length > 10_000) throw new Error('Invalid media index');
        const ids = new Set();
        const covers = new Set();
        const sources = new Set();
        const generated = new Set();
        for (const record of state.records) {
          if (!record || !ID.test(record.id) || ids.has(record.id) || typeof record.orderId !== 'string' || orderKey(record.orderId) !== record.orderId ||
              !TYPES.has(record.contentType) || record.kind !== (record.contentType.startsWith('image/') ? 'image' : 'document') ||
              !Number.isSafeInteger(record.size) || record.size < 1 || typeof record.name !== 'string' ||
              safeName(record.name, record.contentType) !== record.name || !Number.isFinite(Date.parse(record.createdAt)) ||
              (record.deletedAt && !Number.isFinite(Date.parse(record.deletedAt)))) throw new Error('Invalid media index');
          if (record.kind === 'image') dimensions(record.width, record.height);
          if (record.derivedFrom && (record.kind !== 'image' || record.derivedFrom.kind !== 'cdr-preview' ||
              !ID.test(record.derivedFrom.mediaId) || !/^[a-f0-9]{64}$/.test(record.derivedFrom.contentHash) ||
              !state.records.some(parent => parent.id === record.derivedFrom.mediaId && parent.orderId === record.orderId && parent.contentType === 'application/vnd.corel-draw'))) throw new Error('Invalid preview source');
          if (record.source) {
            if (!validSource(record.source) || sources.has(record.source.key) || !/^[a-f0-9]{64}$/.test(record.contentHash)) throw new Error('Invalid mail source');
            sources.add(record.source.key);
          }
          if (record.generatedDocument) {
            if (!validGenerated(record.generatedDocument) || record.contentType!=='application/pdf' || record.source || generated.has(record.generatedDocument.documentId) || !/^[a-f0-9]{64}$/.test(record.contentHash)) throw new Error('Invalid generated document');
            generated.add(record.generatedDocument.documentId);
          }
          if(record.documentLayout&&(!record.generatedDocument||record.generatedDocument.decoration||!validDocumentLayout(record.documentLayout)||record.documentLayout.pdfSha256!==record.contentHash))throw new Error('Invalid generated document layout');
          if (record.cover) {
            if (record.deletedAt || record.kind !== 'image' || covers.has(record.orderId)) throw new Error('Invalid media cover');
            covers.add(record.orderId);
          }
          ids.add(record.id);
        }
        this.state = state;
      }
      try {
        const extra=JSON.parse(await fs.readFile(this.attachmentsPath,'utf8'));
        if(extra.version!==1 || !Array.isArray(extra.records) || extra.records.length>10000) throw new Error('Invalid attachment index');
        const keys=new Set(),ids=new Set(this.state.records.map(r=>r.id));
        for(const r of extra.records) {
          if(!ID.test(r.id) || ids.has(r.id) || r.kind!=='attachment' || r.contentType!=='application/octet-stream' || orderKey(r.orderId)!==r.orderId || attachmentName(r.name)!==r.name || !Number.isSafeInteger(r.size) || r.size<1 || !/^[a-f0-9]{64}$/.test(r.contentHash) || !/^[a-f0-9]{64}$/.test(r.salesSource?.key) || keys.has(r.salesSource.key) || typeof r.salesSource.noteId!=='string' || !Number.isFinite(Date.parse(r.createdAt)) || (r.deletedAt && !Number.isFinite(Date.parse(r.deletedAt)))) throw new Error('Invalid attachment');
          ids.add(r.id);keys.add(r.salesSource.key);
        }
        this.attachments=extra.records;
      } catch(error) {if(error.code!=='ENOENT') throw error;}
      let totalBytes = 0;
      let totalFiles = 0;
      // A bounded startup inventory accounts for tombstones and interrupted uploads.
      for await (const entry of await fs.opendir(this.blobs)) {
        if (++totalFiles > 20_000) throw new Error('Invalid media directory');
        const stat = await fs.lstat(path.join(this.blobs, entry.name));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid media entry');
        totalBytes += stat.size;
      }
      this.totalBytes = totalBytes;
      this.totalFiles = totalFiles;
      return this;
    }).catch(error => { this.ready = null; throw error; });
    return this.ready;
  }

  async mutate(action) {
    await this.init();
    const result = this.writes.then(() => this.guard(action));
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  dto(record) {
    const { id, orderId, name, contentType, size, kind, createdAt, width, height } = record;
    return { id, orderId, name, contentType, size, kind, createdAt, ...(record.source ? { source: { ...record.source } } : {}),
      ...(record.salesSource ? {salesSource:{...record.salesSource}} : {}),
      ...(record.generatedDocument ? { generatedDocument:structuredClone(record.generatedDocument),contentHash:record.contentHash } : {}),
      ...(record.documentLayout ? {documentLayout:structuredClone(record.documentLayout)} : {}),
      ...(record.derivedFrom ? { derivedFrom: { ...record.derivedFrom } } : {}), ...(record.previewStatus ? { previewStatus: record.previewStatus } : {}),
      ...(kind === 'image' ? { width, height } : {}) };
  }

  listing(orderId) {
    const records = [...this.state.records,...this.attachments].filter(record => record.orderId === orderId && !record.deletedAt);
    return { items: records.map(record => this.dto(record)), coverId: records.find(record => record.cover)?.id || null };
  }

  async list(orderId) {
    orderId = orderKey(orderId);
    await this.init();
    await this.writes;
    return this.listing(orderId);
  }

  find(orderId, mediaId, includeDeleted = false) {
    if (typeof mediaId !== 'string' || !ID.test(mediaId)) throw new MediaError('MEDIA_NOT_FOUND', 'Файл не найден.', 404);
    const record = [...this.state.records,...this.attachments].find(value => value.id === mediaId && value.orderId === orderId && (includeDeleted || !value.deletedAt));
    if (!record) throw new MediaError('MEDIA_NOT_FOUND', 'Файл не найден.', 404);
    return record;
  }

  async persist(state) {
    await atomicWrite(this.indexPath, Buffer.from(JSON.stringify(state)));
    this.state = state;
  }

  async add(orderId, { name, contentType, bytes, source, generatedDocument, documentLayout } = {}) {
    orderId = orderKey(orderId);
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw invalidFile();
    if (bytes.length > this.maxFileBytes) throw new MediaError('MEDIA_FILE_TOO_LARGE', 'Файл превышает допустимый размер загрузки.', 413);
    const inspected = inspectMedia(bytes, contentType);
    if (inspected.contentType !== 'application/vnd.corel-draw' && bytes.length > 12 * MIB) throw new MediaError('MEDIA_FILE_TOO_LARGE', 'Для этого формата поддерживается до 12 МБ.', 413);
    name = safeName(name, inspected.contentType);
    if (generatedDocument) {
      if (!validGenerated(generatedDocument) || inspected.contentType!=='application/pdf' || source) throw new MediaError('DOCUMENT_MEDIA_INVALID','Некорректный источник созданного документа.');
      generatedDocument=structuredClone(generatedDocument);
    }
    if (source) {
      if (!validSource(source)) {
        throw new MediaError('MAIL_SOURCE_INVALID', 'Некорректный источник вложения.');
      }
      source = { key: source.key, from: source.from, messageId: source.messageId, partId: source.partId, subject: source.subject, sentAt: source.sentAt,
        ...(source.messageKey ? { messageKey: source.messageKey } : {}), ...(source.publicUrl ? { publicUrl: source.publicUrl } : {}) };
    }
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    if(documentLayout&&(!generatedDocument||generatedDocument.decoration||!validDocumentLayout(documentLayout)||documentLayout.pdfSha256!==contentHash))throw new MediaError('DOCUMENT_LAYOUT_INVALID','Некорректная разметка созданного PDF.');
    if(documentLayout)documentLayout=structuredClone(documentLayout);
    // Own the byte buffer while the operation waits for the serialized writer.
    const contents = Buffer.from(bytes);
    const added = await this.mutate(async () => {
      if (generatedDocument) {
        const previous=this.state.records.find(record=>record.generatedDocument?.documentId===generatedDocument.documentId);
        if(previous) {
          if(previous.orderId!==orderId || previous.contentHash!==contentHash || previous.name!==name || JSON.stringify(previous.generatedDocument)!==JSON.stringify(generatedDocument)||JSON.stringify(previous.documentLayout)!==JSON.stringify(documentLayout)) throw new MediaError('DOCUMENT_MEDIA_CONFLICT','Документ уже сохранён с другими данными.',409);
          if(previous.deletedAt) throw new MediaError('DOCUMENT_MEDIA_DELETED','Файл документа ранее удалён. Повтор не восстанавливает его.',409);
          return this.dto(previous);
        }
      }
      if (source) {
        const previous = this.state.records.find(record => record.source?.key === source.key);
        if (previous) {
          if (previous.orderId !== orderId || previous.contentHash !== contentHash || previous.name !== name) {
            throw new MediaError('MAIL_IMPORT_CONFLICT', 'Это вложение уже обработано с другими данными или для другого заказа.', 409);
          }
          if (previous.deletedAt) throw new MediaError('MAIL_IMPORT_DELETED', 'Вложение ранее удалено из карточки. Повторный импорт не восстанавливает его.', 409);
          return this.dto(previous);
        }
      }
      const active = this.state.records.filter(record => record.orderId === orderId && !record.deletedAt);
      if (active.length >= this.maxFilesPerOrder) throw new MediaError('MEDIA_ORDER_FILE_LIMIT', 'В заказе достигнут лимит файлов.', 409);
      if (active.reduce((sum, record) => sum + record.size, 0) + contents.length > this.maxOrderBytes) {
        throw new MediaError('MEDIA_ORDER_QUOTA', 'Файлы этого заказа превысили допустимый объём.', 413);
      }
      if (this.totalBytes + contents.length > this.maxTotalBytes || Math.max(this.totalFiles, this.state.records.length) >= this.maxTotalFiles) {
        throw new MediaError('MEDIA_STORAGE_QUOTA', 'В хранилище закончилось место для новых файлов. Обратитесь к администратору.', 507);
      }
      const record = {
        id: crypto.randomBytes(16).toString('hex'), orderId, name, ...inspected,
        size: contents.length, createdAt: new Date().toISOString(),
        ...(source ? { source, contentHash } : {}), ...(generatedDocument ? {generatedDocument,contentHash} : {}),
        ...(documentLayout ? {documentLayout:structuredClone(documentLayout)} : {}),
        cover: inspected.kind === 'image' && !active.some(value => value.cover),
      };
      const target = path.join(this.blobs, `${record.id}.bin`);
      await atomicWrite(target, contents);
      this.totalBytes += contents.length;
      this.totalFiles++;
      try { await this.persist({ ...this.state, records: [...this.state.records, record] }); }
      catch (error) {
        try { await fs.unlink(target); this.totalBytes -= contents.length; this.totalFiles--; }
        catch { /* Retain quota accounting for an unindexed file until maintenance. */ }
        throw error;
      }
      return this.dto(record);
    });
    if (inspected.contentType === 'application/vnd.corel-draw') await this.ensureCdrPreview(orderId, added.id);
    return this.dto(this.find(orderId, added.id, true));
  }

  async attachment(orderId, key) {
    await this.init();await this.writes;
    const record=this.attachments.find(r=>r.orderId===orderId && r.salesSource.key===key);
    return record ? {...this.dto(record),deleted:Boolean(record.deletedAt)} : null;
  }
  async persistAttachments(records, beforeCommit) {
    await atomicWrite(this.attachmentsPath,Buffer.from(JSON.stringify({version:1,records})),beforeCommit);
    this.attachments=records;
  }
  async addAttachment(orderId, {name, path:sourcePath, bytes, salesSource, validateSource}) {
    orderId=orderKey(orderId);name=attachmentName(name);
    if(!/^[a-f0-9]{64}$/.test(salesSource?.key) || typeof salesSource.noteId!=='string') throw new MediaError('MEDIA_SOURCE_INVALID','Некорректный источник файла.');
    return this.mutate(async()=>{
      const previous=this.attachments.find(r=>r.salesSource.key===salesSource.key);
      if(previous) {
        if(previous.orderId!==orderId) throw new MediaError('MEDIA_SOURCE_CONFLICT','Файл связан с другим заказом.',409);
        return {...this.dto(previous),deleted:Boolean(previous.deletedAt)};
      }
      const assertSource=()=>{
        if(validateSource && !validateSource()) throw new MediaError('MEDIA_SOURCE_CHANGED','Связь файла изменилась во время переноса.',409);
      };
      assertSource();
      const admit=(size)=>{
        if(this.totalBytes+size>this.maxTotalBytes || Math.max(this.totalFiles,this.state.records.length+this.attachments.length)>=this.maxTotalFiles)
          throw new MediaError('MEDIA_STORAGE_QUOTA','В общем хранилище закончилось место для новых файлов.',507);
      };
      admit(sourcePath ? (await fs.stat(sourcePath)).size : bytes?.length || 0);
      const id=crypto.randomBytes(16).toString('hex'),target=path.join(this.blobs,id+'.bin');
      const hash=crypto.createHash('sha256');let size=0;
      try {
        if(sourcePath) await pipeline(createReadStream(sourcePath),new Transform({transform(chunk,_encoding,done){try{size+=chunk.length;admit(size);hash.update(chunk);done(null,chunk);}catch(error){done(error);}}}),createWriteStream(target,{flags:'wx',mode:0o600}));
        else {if(!Buffer.isBuffer(bytes)) throw new Error('Missing file');size=bytes.length;hash.update(bytes);await atomicWrite(target,bytes);}
        if(!size) throw new Error('Empty file');
        const handle=await fs.open(target,'r+');try{await handle.sync();}finally{await handle.close();}
        if(process.platform!=='win32') {const directory=await fs.open(this.blobs,'r');try{await directory.sync();}finally{await directory.close();}}
        const record={id,orderId,name,contentType:'application/octet-stream',kind:'attachment',size,createdAt:new Date().toISOString(),contentHash:hash.digest('hex'),salesSource:{key:salesSource.key,noteId:salesSource.noteId}};
        // Publish only while the current source link is valid. The final check and
        // rename share one JS turn; no source mutation can interleave with them.
        await this.persistAttachments([...this.attachments,record],assertSource);
        this.totalBytes+=size;this.totalFiles++;
        return this.dto(record);
      } catch(error) {await fs.unlink(target).catch(()=>{});throw error;}
    });
  }
  async open(orderId,mediaId) {
    orderId=orderKey(orderId);await this.init();await this.writes;
    return this.guard(async()=>{
      const record=this.find(orderId,mediaId),target=path.join(this.blobs,record.id+'.bin'),stat=await fs.lstat(target);
      if(!stat.isFile() || stat.isSymbolicLink() || stat.size!==record.size) throw new Error('Invalid stored file');
      return {path:target,size:record.size,mime:record.contentType,name:record.name,media:this.dto(record)};
    });
  }
  async addGenerated(orderId,{name,bytes,generatedDocument,documentLayout}) {
    return this.add(orderId,{name,bytes,contentType:'application/pdf',generatedDocument,documentLayout});
  }

  async generated(orderId,documentId) {
    orderId=orderKey(orderId);await this.init();await this.writes;
    const record=this.state.records.find(record=>record.generatedDocument?.documentId===documentId&&record.orderId===orderId);
    if(!record) return null;
    if(record.deletedAt) throw new MediaError('DOCUMENT_MEDIA_DELETED','Файл документа ранее удалён. Повтор не восстанавливает его.',409);
    return this.dto(record);
  }

  async ensureCdrPreview(orderId, mediaId) {
    return this.mutate(async () => {
      const original = this.find(orderId, mediaId, true);
      if (original.deletedAt || original.contentType !== 'application/vnd.corel-draw' ||
          this.state.records.some(item => item.orderId === orderId && !item.deletedAt && item.cover) ||
          this.state.records.some(item => item.derivedFrom?.mediaId === mediaId) || original.previewStatus === 'unavailable') return;
      let preview, failed = false;
      try {
        const stat = await fs.lstat(path.join(this.blobs, `${mediaId}.bin`));
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== original.size || stat.size > 64 * MIB) throw new Error('Invalid source');
        const sourceBytes = await fs.readFile(path.join(this.blobs, `${mediaId}.bin`));
        const contentHash = crypto.createHash('sha256').update(sourceBytes).digest('hex');
        if (original.contentHash && contentHash !== original.contentHash) throw new Error('Source changed');
        const bytes = corelThumbnail(sourceBytes);
        if (bytes) {
          const inspected = inspectMedia(bytes, 'image/png');
          if (inspected.width > 2048 || inspected.height > 2048) throw new Error('Preview dimensions');
          preview = { bytes, inspected, contentHash };
        }
      } catch { failed = true; /* An optional preview must never undo the original upload. */ }
      const status = preview || failed ? 'error' : 'unavailable';
      if (preview) {
        const active = this.state.records.filter(item => item.orderId === orderId && !item.deletedAt);
        const fits = active.length < this.maxFilesPerOrder && active.reduce((sum, item) => sum + item.size, 0) + preview.bytes.length <= this.maxOrderBytes &&
          this.totalBytes + preview.bytes.length <= this.maxTotalBytes && Math.max(this.totalFiles, this.state.records.length) < this.maxTotalFiles;
        if (fits) {
          const record = { id: crypto.randomBytes(16).toString('hex'), orderId,
            name: safeName(`Превью ${original.name.replace(/\.cdr$/i, '')}.png`, 'image/png'), ...preview.inspected,
            size: preview.bytes.length, createdAt: new Date().toISOString(), cover: true,
            derivedFrom: { kind: 'cdr-preview', mediaId, contentHash: preview.contentHash } };
          const target = path.join(this.blobs, `${record.id}.bin`);
          try {
            await atomicWrite(target, preview.bytes);
            this.totalBytes += preview.bytes.length; this.totalFiles++;
            try {
              const records = this.state.records.map(item => item.id === mediaId ? { ...item, previewStatus: 'ready' } : item);
              await this.persist({ ...this.state, records: [...records, record] });
              return;
            } catch (error) {
              try { await fs.unlink(target); this.totalBytes -= preview.bytes.length; this.totalFiles--; } catch { /* Orphan still counts against quota. */ }
              throw error;
            }
          } catch { /* Retain the original, show the preview failure and retry on startup. */ }
        }
      }
      await this.persist({ ...this.state, records: this.state.records.map(item => item.id === mediaId ? { ...item, previewStatus: status } : item) });
    }).catch(() => undefined); // Original is already durable; preview storage may be unavailable.
  }

  async backfillCdrPreviews() {
    await this.init();
    const originals = this.state.records.filter(item => !item.deletedAt && item.contentType === 'application/vnd.corel-draw');
    for (const original of originals) await this.ensureCdrPreview(original.orderId, original.id);
  }

  async read(orderId, mediaId) {
    orderId = orderKey(orderId);
    await this.init();
    await this.writes;
    return this.guard(async () => {
      const record = this.find(orderId, mediaId);
      const target = path.join(this.blobs, `${record.id}.bin`);
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.size) throw new Error('Invalid stored file');
      const bytes = await fs.readFile(target);
      return { bytes, media: this.dto(record) };
    });
  }

  async setCover(orderId, mediaId) {
    orderId = orderKey(orderId);
    return this.mutate(async () => {
      if (mediaId !== null) {
        const record = this.find(orderId, mediaId);
        if (record.kind !== 'image') throw new MediaError('MEDIA_INVALID_COVER', 'Обложкой можно выбрать только изображение.', 422);
      }
      const records = this.state.records.map(record => record.orderId === orderId ? { ...record, cover: !record.deletedAt && record.id === mediaId } : record);
      await this.persist({ ...this.state, records });
      return this.listing(orderId);
    });
  }

  async remove(orderId, mediaId) {
    orderId = orderKey(orderId);
    return this.mutate(async () => {
      const record = this.find(orderId, mediaId, true);
      if (!record.deletedAt && record.kind==='attachment') {
        await this.persistAttachments(this.attachments.map(r=>r.id===record.id?{...r,deletedAt:new Date().toISOString()}:r));
        return this.listing(orderId);
      }
      if (!record.deletedAt) {
        const records = this.state.records.map(value => value.id === record.id || value.derivedFrom?.mediaId === record.id ? { ...value, cover: false, deletedAt: value.deletedAt || new Date().toISOString() } : value);
        await this.persist({ ...this.state, records });
      }
      return this.listing(orderId);
    });
  }
}
