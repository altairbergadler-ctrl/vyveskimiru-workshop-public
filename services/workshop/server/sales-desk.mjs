import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeOrderDraft } from './sales-order.mjs';

export class SalesError extends Error {
  constructor(code, message, statusCode = 400, current = null) {
    super(message);
    this.name = 'SalesError';
    Object.assign(this, { code, statusCode, current });
  }
}
export const salesHash = (value) =>
  crypto
    .createHash('sha256')
    .update(
      typeof value === 'string' || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest('hex');
export const salesChatId = (e) =>
  salesHash(['chat', e.source, e.account, e.conversationId || e.nativeId]);
const fail = (message, code = 'SALES_INPUT', status = 400, current = null) => {
  throw new SalesError(code, message, status, current);
};
const uid = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(value);
const text = (value, max = 200, required = false) => {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    value.includes('\0') ||
    (required && !value.trim())
  )
    fail('Проверьте заполнение полей.');
  return value.trim();
};
const date = (value) => {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    fail('Укажите корректную дату и время.');
  return new Date(value).toISOString();
};
const pick = (value, values) => {
  if (!values.includes(value)) fail('Недопустимое состояние.');
  return value;
};
const fields = (value, allowed) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    fail('Неизвестные поля запроса.');
};
const terminalNote = (n) =>
  Boolean(n.trashedAt) || ['archived', 'merged'].includes(n.status);
const timestamp = (now) => new Date(now()).toISOString();
const noteFields = [
  'title',
  'client',
  'owner',
  'status',
  'priority',
  'manual',
  'waitingFor',
  'reviewAt',
  'orderId',
  'color',
];
// Authorized VPS business store for sales only. Google retains orders and money.
export class SalesDesk {
  constructor({ db, now = Date.now, filesDirectory = null }) {
    Object.assign(this, { db, now, filesDirectory });
    // SQLite lower() folds ASCII only; inbox search must also match Russian case.
    db.function('sales_lower', { deterministic: true }, (value) =>
      String(value ?? '').toLowerCase(),
    );
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE IF NOT EXISTS sales_notes(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sales_tasks(id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES sales_notes(id), revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sales_task_note ON sales_tasks(note_id);
      CREATE TABLE IF NOT EXISTS sales_events(id TEXT PRIMARY KEY, source TEXT NOT NULL, account TEXT NOT NULL, native_id TEXT NOT NULL, version TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, received_at TEXT NOT NULL, UNIQUE(source,account,native_id));
      CREATE TABLE IF NOT EXISTS sales_event_versions(seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES sales_events(id), version TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(event_id,version));
      CREATE TABLE IF NOT EXISTS sales_links(event_id TEXT NOT NULL REFERENCES sales_events(id), note_id TEXT NOT NULL REFERENCES sales_notes(id), PRIMARY KEY(event_id,note_id));
      CREATE TABLE IF NOT EXISTS sales_commands(id TEXT PRIMARY KEY, hash TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sales_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, note_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sales_audit_note ON sales_audit(note_id,seq);
      CREATE TABLE IF NOT EXISTS sales_layouts(profile TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sales_read(profile TEXT NOT NULL,note_id TEXT NOT NULL, watermark TEXT NOT NULL, PRIMARY KEY(profile,note_id));
      CREATE TABLE IF NOT EXISTS sales_files(id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES sales_notes(id), name TEXT NOT NULL, mime TEXT NOT NULL, hash TEXT NOT NULL, bytes BLOB NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sales_merges(id TEXT PRIMARY KEY, target_id TEXT NOT NULL, source_id TEXT NOT NULL, data TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sales_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sales_notices(id TEXT PRIMARY KEY,profile TEXT NOT NULL,task_id TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sales_jobs(id TEXT PRIMARY KEY,note_id TEXT NOT NULL,revision INTEGER NOT NULL,watermark TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sales_job_note_state ON sales_jobs(note_id,state);
      CREATE TABLE IF NOT EXISTS sales_outgoing(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,message_id TEXT,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sales_sources(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
    // A separate index keeps the eight-column event contract usable by code rollback.
    db.exec(`CREATE TABLE IF NOT EXISTS sales_event_chats(event_id TEXT PRIMARY KEY REFERENCES sales_events(id),chat_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sales_chat_events ON sales_event_chats(chat_id,event_id)`);
    db.transaction(() => {
      const save = db.prepare(
        'INSERT INTO sales_event_chats VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET chat_id=excluded.chat_id',
      );
      for (const row of db.prepare('SELECT id,data FROM sales_events').all())
        save.run(row.id, salesChatId(JSON.parse(row.data)));
    })();
    if (!this.setting('startedAt'))
      this.setSetting('startedAt', timestamp(now));
    // Automatic work is durable. A restart may repeat a read-only model request,
    // but finishAnalysis still guards the current note revision and source watermark.
    db.prepare(
      "UPDATE sales_jobs SET state='pending' WHERE state='running' AND json_extract(data,'$.automatic')=1",
    ).run();
    db.prepare(
      "UPDATE sales_jobs SET state='error',data=json_set(data,'$.code','ANALYSIS_INTERRUPTED') WHERE state='running'",
    ).run();
  }
  setting(key) {
    const row = this.db
      .prepare('SELECT value FROM sales_settings WHERE key=?')
      .get(key);
    return row ? JSON.parse(row.value) : null;
  }
  setSetting(key, value) {
    this.db
      .prepare(
        'INSERT INTO sales_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  settings() {
    return {
      timezone: 'Europe/Moscow',
      startHour: 9,
      endHour: 19,
      days: [1, 2, 3, 4, 5],
      owners: ['Руководитель'],
      ...this.setting('preferences'),
    };
  }
  decode(row) {
    return row
      ? { ...JSON.parse(row.data), id: row.id, revision: row.revision }
      : null;
  }
  note(id) {
    const value = this.decode(
      this.db.prepare('SELECT * FROM sales_notes WHERE id=?').get(id),
    );
    if (!value) fail('Записка не найдена.', 'SALES_NOT_FOUND', 404);
    return {
      ...value,
      status: value.status === 'triage' ? 'active' : value.status,
    };
  }
  task(id) {
    const row = this.db.prepare('SELECT * FROM sales_tasks WHERE id=?').get(id);
    if (!row) fail('Задача не найдена.', 'SALES_NOT_FOUND', 404);
    return { ...this.decode(row), noteId: row.note_id };
  }
  tasks(noteId) {
    return this.db
      .prepare('SELECT * FROM sales_tasks WHERE note_id=?')
      .all(noteId)
      .map((r) => ({ ...this.decode(r), noteId: r.note_id }));
  }
  notes() {
    return this.db
      .prepare('SELECT * FROM sales_notes')
      .all()
      .map((r) => {
        const n = this.decode(r);
        return { ...n, status: n.status === 'triage' ? 'active' : n.status };
      });
  }
  expect(value, revision) {
    if (value.revision !== revision)
      fail(
        'Данные уже изменились. Сравните свежую версию и повторите правку.',
        'SALES_CONFLICT',
        409,
        value,
      );
  }
  writable(note) {
    if (terminalNote(note))
      fail('Сначала восстановите или разделите записку.', 'SALES_CLOSED', 409);
  }
  putNote(note) {
    const value = {
      ...note,
      revision: note.revision + 1,
      updatedAt: timestamp(this.now),
    };
    this.db
      .prepare(
        'INSERT INTO sales_notes VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data',
      )
      .run(value.id, value.revision, JSON.stringify(value));
    return value;
  }
  putTask(task) {
    const value = {
      ...task,
      revision: task.revision + 1,
      updatedAt: timestamp(this.now),
    };
    this.db
      .prepare(
        'INSERT INTO sales_tasks VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET note_id=excluded.note_id,revision=excluded.revision,data=excluded.data',
      )
      .run(value.id, value.noteId, value.revision, JSON.stringify(value));
    return value;
  }
  audit(noteId, actor, action, data) {
    this.db
      .prepare(
        'INSERT INTO sales_audit(note_id,actor,action,data,at) VALUES(?,?,?,?,?)',
      )
      .run(noteId, actor, action, JSON.stringify(data), timestamp(this.now));
  }
  watermark(noteId) {
    return salesHash(
      this.db
        .prepare(
          'SELECT e.id,e.version,e.revision FROM sales_events e JOIN sales_links l ON l.event_id=e.id WHERE l.note_id=? ORDER BY e.id',
        )
        .all(noteId),
    );
  }
  events(noteId) {
    return this.db
      .prepare(
        'SELECT e.* FROM sales_events e JOIN sales_links l ON l.event_id=e.id WHERE l.note_id=? ORDER BY e.received_at,e.id',
      )
      .all(noteId)
      .map((r) => ({
        ...JSON.parse(r.data),
        id: r.id,
        version: r.version,
        revision: r.revision,
        receivedAt: r.received_at,
      }));
  }
  command(input, actor = 'Руководитель', profile = 'owner') {
    fields(input, ['requestId', 'action', 'data']);
    if (!uid(input.requestId)) fail('Нужен устойчивый ID команды.');
    const hash = salesHash({
      action: input.action,
      data: input.data,
      actor,
      profile,
    });
    return this.db.transaction(() => {
      const previous = this.db
        .prepare('SELECT * FROM sales_commands WHERE id=?')
        .get(input.requestId);
      if (previous) {
        if (previous.hash !== hash)
          fail(
            'Этот ID уже использован другой командой.',
            'SALES_ID_REUSED',
            409,
          );
        return JSON.parse(previous.result);
      }
      const result = this.apply(
        input.action,
        input.data,
        actor,
        profile,
        input.requestId,
      );
      this.db
        .prepare('INSERT INTO sales_commands VALUES(?,?,?,?)')
        .run(
          input.requestId,
          hash,
          JSON.stringify(result),
          timestamp(this.now),
        );
      return result;
    })();
  }
  validateNote(patch) {
    fields(patch, noteFields);
    const clean = {};
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'status')
        clean[key] = pick(value, ['active', 'waiting', 'archived']);
      else if (key === 'priority') clean[key] = pick(value, ['normal', 'high']);
      else if (key === 'color')
        clean[key] = pick(value, ['yellow', 'green', 'blue', 'lilac', 'rose']);
      else if (key === 'reviewAt') clean[key] = date(value);
      else
        clean[key] = text(
          value,
          key === 'manual' ? 10000 : key === 'waitingFor' ? 1000 : 250,
          key === 'title' || key === 'owner',
        );
    }
    return clean;
  }
  createNote(data, actor, id = crypto.randomUUID()) {
    const clean = this.validateNote(data);
    if (!clean.title || !clean.owner)
      fail('Укажите название обращения и ответственного.');
    const note = {
      id,
      revision: 0,
      client: '',
      status: 'active',
      priority: 'normal',
      color: 'yellow',
      manual: '',
      waitingFor: '',
      reviewAt: null,
      orderId: '',
      summary: null,
      createdAt: timestamp(this.now),
      ...clean,
    };
    if (note.status === 'archived') fail('Новая записка должна быть активной.');
    if (note.status === 'waiting' && (!note.waitingFor || !note.reviewAt))
      fail('У ожидания нужны причина и контрольная дата.');
    const saved = this.putNote(note);
    this.audit(id, actor, 'note.create', { after: saved });
    return saved;
  }
  apply(action, data, actor, profile, requestId) {
    if (action === 'chat.create')
      return this.createChatNote(data, actor, requestId);
    if (action === 'note.create') return this.createNote(data, actor);
    if (action === 'note.trash' || action === 'note.restore') {
      fields(data, ['id', 'trashId']);
      const note = this.note(data.id);
      const removing = action === 'note.trash';
      // Deletion only adds a tombstone: concurrent summaries/manual edits survive.
      // A restore targets one deletion, so an old Undo cannot revive a later one.
      if (!removing && note.trashedAt && data.trashId !== note.trashId)
        fail(
          'Карточка удалена повторно. Откройте корзину.',
          'SALES_CONFLICT',
          409,
        );
      if (Boolean(note.trashedAt) === removing) return note;
      if (removing && note.status === 'merged')
        fail(
          'Удалите основную карточку после объединения.',
          'SALES_CLOSED',
          409,
        );
      const saved = this.putNote({
        ...note,
        trashedAt: removing ? timestamp(this.now) : null,
        trashId: removing ? requestId : null,
      });
      if (removing)
        this.db
          .prepare(
            "UPDATE sales_jobs SET state='stale' WHERE note_id=? AND state IN ('pending','running')",
          )
          .run(note.id);
      else this.enqueueAutoAnalysis(note.id);
      this.audit(note.id, actor, action, { trashedAt: saved.trashedAt });
      return saved;
    }
    if (action === 'note.manual') {
      fields(data, ['id', 'before', 'manual']);
      const note = this.note(data.id);
      this.writable(note);
      text(data.before, 20000);
      const manual = this.validateNote({ manual: data.manual }).manual;
      if (note.manual !== data.before)
        fail(
          'Заметку изменили в другой вкладке. Ваш текст сохранён в черновике.',
          'SALES_CONFLICT',
          409,
          note,
        );
      const saved = this.putNote({ ...note, manual });
      this.audit(note.id, actor, 'note.manual', {
        before: note.manual,
        after: manual,
      });
      return saved;
    }
    if (action === 'note.update') {
      fields(data, ['id', 'revision', 'patch']);
      const before = this.note(data.id);
      this.expect(before, data.revision);
      if (before.trashedAt || before.status === 'merged')
        fail(
          'Используйте основную записку или отмените объединение.',
          'SALES_CLOSED',
          409,
        );
      const after = { ...before, ...this.validateNote(data.patch) };
      if (
        Object.hasOwn(data.patch, 'title') &&
        data.patch.title !== before.title
      )
        after.titleEdited = true;
      if (
        after.status === 'waiting' &&
        (!after.waitingFor || !after.reviewAt || !after.owner)
      )
        fail('У ожидания нужны ответственный, причина и контрольная дата.');
      const saved = this.putNote(after);
      this.audit(before.id, actor, 'note.update', { before, after: saved });
      return saved;
    }
    if (action.startsWith('task.'))
      fail('Задачи удалены из рабочего стола.', 'SALES_REMOVED', 410);
    if (action === 'event.link') {
      fields(data, [
        'eventId',
        'noteId',
        'revision',
        'newNote',
        'eventRevision',
      ]);
      const event = this.db
        .prepare('SELECT * FROM sales_events WHERE id=?')
        .get(data.eventId);
      if (!event) fail('Источник не найден.', 'SALES_NOT_FOUND', 404);
      this.expect(event, data.eventRevision);
      if (
        data.newNote &&
        this.db
          .prepare('SELECT 1 FROM sales_links WHERE event_id=?')
          .get(event.id)
      )
        fail(
          'Событие уже разобрано другим сотрудником. Обновите входящие; при необходимости свяжите его с другой запиской явно.',
          'SALES_ALREADY_LINKED',
          409,
        );
      const note = data.newNote
        ? this.createNote(data.newNote, actor)
        : this.note(data.noteId);
      this.writable(note);
      if (!data.newNote) this.expect(note, data.revision);
      this.db
        .prepare('INSERT OR IGNORE INTO sales_links VALUES(?,?)')
        .run(event.id, note.id);
      this.putNote(note);
      this.audit(note.id, actor, 'event.link', {
        eventId: event.id,
        version: event.version,
      });
      return { noteId: note.id };
    }
    if (action === 'event.unread' || action === 'note.read') {
      fields(data, ['id', 'watermark']);
      const note = this.note(data.id);
      if (action === 'note.read' && data.watermark !== this.watermark(note.id))
        fail('Поступили новые события.', 'SALES_CONFLICT', 409);
      this.db
        .prepare(
          'INSERT INTO sales_read VALUES(?,?,?) ON CONFLICT(profile,note_id) DO UPDATE SET watermark=excluded.watermark',
        )
        .run(profile, note.id, action === 'note.read' ? data.watermark : '');
      return { ok: true };
    }
    if (action === 'layout.patch') {
      fields(data, ['positions', 'zones', 'zoom', 'mode']);
      const current = this.layout(profile);
      const merged = structuredClone(current);
      if (data.zones !== undefined) {
        if (!Array.isArray(data.zones)) fail('Некорректные зоны.');
        for (const zone of data.zones) {
          fields(zone, ['id', 'name']);
          const i = merged.zones.findIndex((z) => z.id === zone.id);
          if (i < 0) merged.zones.push(zone);
          else merged.zones[i] = zone;
        }
      }
      if (data.positions !== undefined) {
        if (
          !data.positions ||
          typeof data.positions !== 'object' ||
          Array.isArray(data.positions)
        )
          fail('Некорректная раскладка.');
        for (const [id, patch] of Object.entries(data.positions)) {
          if (!uid(id)) fail('Некорректная записка.');
          fields(patch, ['x', 'y', 'pinned', 'zone', 'initial']);
          const { initial, ...changes } = patch;
          if (initial !== undefined) {
            fields(initial, ['x', 'y']);
            if (
              ![initial.x, initial.y].every(
                (v) => Number.isFinite(v) && v >= 0 && v <= 10000,
              )
            )
              fail('Некорректная начальная позиция.');
          }
          // Initial rendered coordinates are a fallback, never a stale overwrite.
          merged.positions[id] = {
            x: 0,
            y: 0,
            pinned: false,
            zone: '',
            ...(merged.positions[id] || initial),
            ...changes,
          };
        }
      }
      if (data.zoom !== undefined) merged.zoom = data.zoom;
      if (data.mode !== undefined) merged.mode = data.mode;
      // Existing validation and receipt transaction, with the latest layout base.
      return this.apply('layout.save', merged, actor, profile, requestId);
    }
    if (action === 'layout.save') {
      fields(data, ['revision', 'positions', 'zones', 'zoom', 'mode']);
      const current = this.layout(profile);
      this.expect(current, data.revision);
      if (
        !Array.isArray(data.zones) ||
        data.zones.length > 30 ||
        !data.positions ||
        typeof data.positions !== 'object' ||
        Array.isArray(data.positions) ||
        Object.keys(data.positions).length > 2000
      )
        fail('Слишком большая раскладка.');
      const zones = data.zones.map((z) => {
        fields(z, ['id', 'name']);
        if (!uid(z.id)) fail('Некорректная зона.');
        return { id: z.id, name: text(z.name, 60, true) };
      });
      if (new Set(zones.map((z) => z.id)).size !== zones.length)
        fail('Повтор зоны.');
      const positions = {};
      for (const [id, pos] of Object.entries(data.positions)) {
        if (!uid(id)) fail('Некорректная записка.');
        fields(pos, ['x', 'y', 'pinned', 'zone']);
        if (
          !Number.isFinite(pos.x) ||
          !Number.isFinite(pos.y) ||
          pos.x < 0 ||
          pos.y < 0 ||
          pos.x > 10000 ||
          pos.y > 10000 ||
          typeof pos.pinned !== 'boolean' ||
          typeof pos.zone !== 'string' ||
          (pos.zone && !zones.some((z) => z.id === pos.zone))
        )
          fail('Некорректная позиция.');
        positions[id] = pos;
      }
      if (!Number.isFinite(data.zoom) || data.zoom < 0.5 || data.zoom > 1.5)
        fail('Некорректный масштаб.');
      const mode = pick(data.mode ?? current.mode ?? 'free', [
        'free',
        'newest',
      ]);
      const value = { positions, zones, zoom: data.zoom, mode };
      this.db
        .prepare(
          'INSERT INTO sales_layouts VALUES(?,?,?) ON CONFLICT(profile) DO UPDATE SET revision=excluded.revision,data=excluded.data',
        )
        .run(profile, current.revision + 1, JSON.stringify(value));
      return { ...value, revision: current.revision + 1 };
    }
    if (action === 'intake.configure') {
      fields(data, ['policy']);
      const policy = pick(data.policy, ['new', '30days']);
      if (this.setting('intakePolicy'))
        fail(
          'Приём уже настроен. Обновите страницу.',
          'SALES_ALREADY_CONFIGURED',
          409,
        );
      const startedAt = timestamp(this.now);
      this.setSetting('startedAt', startedAt);
      this.setSetting('intakePolicy', policy);
      this.audit(null, actor, 'intake.configure', { policy, startedAt });
      return { policy, startedAt };
    }
    if (action === 'settings.save') {
      fields(data, ['timezone', 'startHour', 'endHour', 'days', 'owners']);
      try {
        new Intl.DateTimeFormat('ru', { timeZone: data.timezone });
      } catch {
        fail('Неизвестный часовой пояс.');
      }
      if (
        !Number.isInteger(data.startHour) ||
        !Number.isInteger(data.endHour) ||
        data.startHour < 0 ||
        data.endHour > 24 ||
        data.startHour >= data.endHour ||
        !Array.isArray(data.days) ||
        !data.days.length ||
        data.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) ||
        !Array.isArray(data.owners) ||
        !data.owners.length ||
        data.owners.length > 50
      )
        fail('Проверьте рабочее время и ответственных.');
      const value = {
        ...data,
        owners: [...new Set(data.owners.map((v) => text(v, 100, true)))],
      };
      this.setSetting('preferences', value);
      this.audit(null, actor, action, { after: value });
      return value;
    }
    if (action === 'notes.merge') return this.merge(data, actor, requestId);
    if (action === 'notes.unmerge') return this.unmerge(data, actor);
    if (action === 'notes.split') return this.split(data, actor);
    if (action === 'file.approve') {
      fields(data, ['id', 'noteId', 'revision', 'reason']);
      const note = this.note(data.noteId);
      this.writable(note);
      this.expect(note, data.revision);
      const row = this.db
        .prepare('SELECT * FROM sales_files WHERE id=? AND note_id=?')
        .get(data.id, note.id);
      if (!row) fail('Файл не найден.', 'SALES_NOT_FOUND', 404);
      const reason = text(data.reason, 1000, true);
      this.putNote({ ...note, approvedFile: row.id });
      this.audit(note.id, actor, action, {
        fileId: row.id,
        hash: row.hash,
        reason,
      });
      return { ok: true };
    }
    fail('Неизвестная команда.');
  }
  layout(profile) {
    const row = this.db
      .prepare('SELECT * FROM sales_layouts WHERE profile=?')
      .get(profile);
    return row
      ? { ...JSON.parse(row.data), revision: row.revision }
      : { revision: 0, positions: {}, zones: [], zoom: 1 };
  }
  displayTitle(note) {
    if (note.titleEdited || !this.events(note.id).length) return note.title;
    const proposed =
      note.summary?.requestTitle ||
      note.summary?.orderDraft?.title ||
      note.requestTitle;
    if (proposed) return proposed.slice(0, 120);
    const request =
      (note.summary?.text || '')
        .split(/##\s*Запрос\s*\n/i)[1]
        ?.split(/\n##/)[0] ||
      (note.summary?.text || '')
        .split('\n')
        .find((line) => line.trim() && !line.startsWith('#'));
    if (request)
      return request
        .replace(/^[\s•*-]+/, '')
        .split(/(?<=[.!?])\s/)[0]
        .slice(0, 120);
    return 'Запрос клиента';
  }
  channelScope(id) {
    return salesHash(
      [
        ...new Set(
          this.events(id)
            .filter((e) => !e.deleted)
            .map(salesChatId),
        ),
      ].sort((a,b)=>a.localeCompare(b)),
    );
  }
  orderTransfer(id) {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sales_order_transfers'",
        )
        .get()
    )
      return null;
    const row = this.db
      .prepare('SELECT * FROM sales_order_transfers WHERE note_id=?')
      .get(id);
    if (!row) return null;
    const data = JSON.parse(row.data),
      pending = data.retry?.length || 0;
    return {
      orderId: row.order_id,
      done: data.cursor >= data.entries.length && !pending,
      processed: data.cursor,
      total: data.entries.length,
      pending,
      unavailable: data.unavailable.length,
    };
  }
  detail(id) {
    const note = this.note(id);
    return {
      ...note,
      channelClient:
        note.channelClientScope === this.channelScope(id)
          ? note.channelClient || ''
          : '',
      orderTransfer: this.orderTransfer(id),
      displayTitle: this.displayTitle(note),
      analysis: this.analysisStatus(note),
      events: this.events(id),
      chats: [
        ...new Map(
          this.events(id).map((e) => [
            salesChatId(e),
            { id: salesChatId(e), source: e.source, title: e.title },
          ]),
        ).values(),
      ],
      watermark: this.watermark(id),
      files: this.files(id),
      jobs: this.db
        .prepare(
          'SELECT id,state,at,data,revision,watermark FROM sales_jobs WHERE note_id=? ORDER BY at DESC,rowid DESC LIMIT 10',
        )
        .all(id)
        .map((r) => ({ ...r, data: JSON.parse(r.data) })),
      merges: this.db
        .prepare(
          'SELECT id,source_id AS sourceId,undone FROM sales_merges WHERE target_id=?',
        )
        .all(id),
    };
  }
  files(noteId) {
    return this.db
      .prepare(
        "SELECT id,name,mime,hash,revision,coalesce(json_extract(data,'$.size'),length(bytes)) AS size,data FROM sales_files WHERE note_id=?",
      )
      .all(noteId)
      .map((r) => ({ ...JSON.parse(r.data), ...r, data: undefined }));
  }
  chatNotes(chatId) {
    return this.db
      .prepare(
        `SELECT DISTINCT n.* FROM sales_notes n JOIN sales_links l ON l.note_id=n.id JOIN sales_events e ON e.id=l.event_id JOIN sales_event_chats c ON c.event_id=e.id WHERE c.chat_id=?`,
      )
      .all(chatId)
      .map((r) => {
        const n = this.decode(r);
        return { ...n, status: n.status === 'triage' ? 'active' : n.status };
      });
  }
  createChatNote(data, actor, requestId) {
    fields(data, ['chatId', 'noteId', 'title']);
    if (data.title !== undefined) text(data.title, 250, true);
    if (!uid(data.chatId)) fail('Выберите чат.');
    const rows = this.db
      .prepare(
        'SELECT e.* FROM sales_events e JOIN sales_event_chats c ON c.event_id=e.id WHERE c.chat_id=? ORDER BY e.received_at,e.id',
      )
      .all(data.chatId);
    if (!rows.length) fail('Чат не найден.', 'SALES_NOT_FOUND', 404);
    const candidates = this.chatNotes(data.chatId).filter(
      (n) => !terminalNote(n),
    );
    if (candidates.length > 1 && !data.noteId)
      fail(
        'В этом чате несколько обращений. Выберите карточку для новых сообщений.',
        'SALES_CHAT_AMBIGUOUS',
        409,
      );
    let note = data.noteId
      ? candidates.find((n) => n.id === data.noteId)
      : candidates[0];
    if (data.noteId && !note) fail('Выберите действующую карточку этого чата.');
    const unlinked = this.db
      .prepare(
        'SELECT count(*) AS n FROM sales_events e JOIN sales_event_chats c ON c.event_id=e.id WHERE c.chat_id=? AND NOT EXISTS(SELECT 1 FROM sales_links l WHERE l.event_id=e.id)',
      )
      .get(data.chatId).n;
    if (!unlinked) {
      const existing = note || this.chatNotes(data.chatId).at(-1);
      if (existing)
        return { noteId: existing.id, jobId: null, created: false, linked: 0 };
    }
    const created = !note;
    if (!note) {
      note = this.createNote(
        {
          title: 'Запрос клиента',
          owner: 'Руководитель',
        },
        actor,
      );
    }
    let linked = 0;
    const insert = this.db.prepare(
      created
        ? 'INSERT OR IGNORE INTO sales_links VALUES(?,?)'
        : 'INSERT INTO sales_links SELECT ?,? WHERE NOT EXISTS(SELECT 1 FROM sales_links WHERE event_id=?)',
    );
    for (const e of rows)
      linked += insert.run(
        ...(created ? [e.id, note.id] : [e.id, note.id, e.id]),
      ).changes;
    if (linked) {
      note = this.putNote(note);
      this.audit(note.id, actor, 'chat.link', {
        chatId: data.chatId,
        events: linked,
      });
    }
    const watermark = this.watermark(note.id);
    // One durable job per accepted note version, even for concurrent click IDs.
    const job =
      this.db
        .prepare(
          "SELECT id,state FROM sales_jobs WHERE note_id=? AND revision=? AND watermark=? AND state IN ('pending','running','done') ORDER BY at DESC LIMIT 1",
        )
        .get(note.id, note.revision, watermark) ||
      this.beginAnalysis(note.id, note.revision, requestId);
    return { noteId: note.id, jobId: job.id, created, linked };
  }
  readChats({
    cursor = '',
    query = '',
    channel = '',
    scope = 'pending',
    titleMatches = [],
  } = {}) {
    const q = text(query, 200).toLowerCase();
    text(channel, 40);
    pick(scope, ['pending', 'all']);
    let before = null;
    if (cursor) {
      try {
        if (
          typeof cursor !== 'string' ||
          cursor.length > 1024 ||
          !/^[a-zA-Z0-9_-]+$/.test(cursor)
        )
          throw new Error();
        before = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (
          !Array.isArray(before) ||
          before.length !== 5 ||
          date(before[0]) !== before[0] ||
          !uid(before[1]) ||
          before[2] !== q ||
          before[3] !== channel ||
          before[4] !== scope
        )
          throw new Error();
      } catch {
        fail('Неверная страница чатов.');
      }
    }
    const grouped = `WITH grouped AS (SELECT c.chat_id AS id, e.source, e.account, count(*) AS messages, max(e.received_at) AS latest,
      sum(NOT EXISTS(SELECT 1 FROM sales_links l WHERE l.event_id=e.id)) AS pending,
      max(CASE WHEN instr(sales_lower(coalesce(json_extract(e.data,'$.title'),'') || ' ' || coalesce(json_extract(e.data,'$.conversationId'),'')),?)>0 OR c.chat_id IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END) AS matched
      FROM sales_events e JOIN sales_event_chats c ON c.event_id=e.id GROUP BY c.chat_id,e.source,e.account)`;
    const scopeSql = scope === 'pending' ? 'pending>0' : '1=1';
    const channels = this.db
      .prepare(
        grouped +
          ` SELECT source,count(*) AS chats,sum(messages) AS messages,sum(pending) AS pending FROM grouped WHERE ${scopeSql} GROUP BY source`,
      )
      .all(q, JSON.stringify(titleMatches));
    const filter =
      `${scopeSql} AND matched=1` + (channel ? ' AND source=?' : '');
    const params = [
      q,
      JSON.stringify(titleMatches),
      ...(channel ? [channel] : []),
    ];
    const total = this.db
      .prepare(grouped + ` SELECT count(*) AS n FROM grouped WHERE ${filter}`)
      .get(...params).n;
    const rows = this.db
      .prepare(
        grouped +
          ` SELECT * FROM grouped WHERE ${filter}` +
          (before ? ' AND (latest<? OR (latest=? AND id<?))' : '') +
          ' ORDER BY latest DESC,id DESC LIMIT 51',
      )
      .all(...params, ...(before ? [before[0], before[0], before[1]] : []));
    const items = rows.slice(0, 50).map((r) => {
      const event = this.db
        .prepare(
          "SELECT e.id,e.data FROM sales_events e JOIN sales_event_chats c ON c.event_id=e.id WHERE c.chat_id=? ORDER BY coalesce(json_extract(e.data,'$.occurredAt'),e.received_at) DESC,e.id DESC LIMIT 1",
        )
        .get(r.id);
      const e = JSON.parse(event.data);
      return {
        ...r,
        title: e.title,
        conversationId: e.conversationId,
        occurredAt: e.occurredAt,
        eventId: event.id,
        url: e.url,
        notes: this.chatNotes(r.id).map((n) => ({
          id: n.id,
          title: n.title,
          status: n.status,
          trashedAt: n.trashedAt || null,
        })),
      };
    });
    const last = items.at(-1);
    return {
      items,
      channels,
      page: {
        total,
        query: q,
        channel,
        scope,
        nextCursor:
          rows.length > 50
            ? Buffer.from(
                JSON.stringify([last.latest, last.id, q, channel, scope]),
              ).toString('base64url')
            : '',
      },
    };
  }
  readInbox({ cursor = '', query = '' } = {}) {
    const q = text(query, 200).toLowerCase();
    let before = null;
    if (cursor) {
      try {
        if (
          typeof cursor !== 'string' ||
          cursor.length > 512 ||
          !/^[a-zA-Z0-9_-]+$/.test(cursor)
        )
          throw new Error();
        before = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (
          !Array.isArray(before) ||
          before.length !== 2 ||
          typeof before[0] !== 'string' ||
          date(before[0]) !== before[0] ||
          !uid(before[1])
        )
          throw new Error();
      } catch {
        fail('Неверная страница входящих.');
      }
    }
    const unlinked =
      'NOT EXISTS(SELECT 1 FROM sales_links l WHERE l.event_id=e.id)';
    const total = this.db
      .prepare(`SELECT count(*) AS total FROM sales_events e WHERE ${unlinked}`)
      .get().total;
    const search = q
      ? " AND instr(sales_lower(coalesce(json_extract(data,'$.title'),'') || ' ' || source || ' ' || coalesce(json_extract(data,'$.conversationId'),'')),?)>0"
      : '';
    const params = q ? [q] : [];
    const matched = q
      ? this.db
          .prepare(
            `SELECT count(*) AS total FROM sales_events e WHERE ${unlinked}${search}`,
          )
          .get(...params).total
      : total;
    // A stable key prevents skipped events when another owner links a previous page.
    const after = before
      ? ' AND (received_at<? OR (received_at=? AND id<?))'
      : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM sales_events e WHERE ${unlinked}${search}${after} ORDER BY received_at DESC,id DESC LIMIT 101`,
      )
      .all(...params, ...(before ? [before[0], before[0], before[1]] : []));
    const hasMore = rows.length > 100;
    const visible = rows.slice(0, 100);
    const last = visible.at(-1);
    return {
      items: visible.map((r) => ({
        ...JSON.parse(r.data),
        id: r.id,
        revision: r.revision,
        receivedAt: r.received_at,
      })),
      total,
      page: {
        total: matched,
        query: q,
        nextCursor: hasMore
          ? Buffer.from(JSON.stringify([last.received_at, last.id])).toString(
              'base64url',
            )
          : '',
      },
    };
  }
  snapshot(profile = 'owner', inboxOptions = {}) {
    const allNotes = this.notes();
    const read = new Map(
      this.db
        .prepare('SELECT note_id,watermark FROM sales_read WHERE profile=?')
        .all(profile)
        .map((r) => [r.note_id, r.watermark]),
    );
    const notes = allNotes
      .filter((n) => !n.trashedAt)
      .map((n) => {
        const events = this.events(n.id);
        const watermark = this.watermark(n.id);
        return {
          ...n,
          unread: events.length > 0 && read.get(n.id) !== watermark,
          displayTitle: this.displayTitle(n),
          analysis: this.analysisStatus(n),
          summaryStale: Boolean(n.summary && n.summary.watermark !== watermark),
          summaryPartial: Boolean(n.summary?.partial),
          channels: [...new Set(events.map((e) => e.source))],
          searchText: this.files(n.id)
            .map((f) => f.name)
            .join(' '),
          fileCount: this.files(n.id).length,
        };
      });
    const {
      items: inbox,
      page: inboxPage,
      total: inboxTotal,
    } = this.readInbox(inboxOptions);
    const chats = this.readChats({
      ...inboxOptions,
      cursor: inboxOptions.chatCursor || '',
    });
    const settings = this.settings();
    const current = timestamp(this.now);
    const localDate = (value) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: settings.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(value));
    const today = localDate(this.now());
    const todayItems = notes
      .filter(
        (n) =>
          n.status === 'waiting' &&
          n.reviewAt &&
          localDate(n.reviewAt) <= today,
      )
      .map((n) => ({
        kind: 'waiting',
        noteId: n.id,
        title: this.displayTitle(n),
        owner: n.owner,
        reviewAt: n.reviewAt,
      }));
    // The day's queue must not disappear behind a page of historical imports.
    const newInboxCount = this.db
      .prepare(
        `SELECT count(*) AS total FROM sales_events e WHERE NOT EXISTS(SELECT 1 FROM sales_links l WHERE l.event_id=e.id) AND coalesce(json_extract(data,'$.historical'),0)=0`,
      )
      .get().total;
    if (newInboxCount)
      todayItems.push({
        kind: 'inbox',
        title: `Новые сообщения: ${newInboxCount}`,
        owner: 'Руководитель',
        count: newInboxCount,
      });
    return {
      notes,
      trash: allNotes
        .filter((n) => n.trashedAt)
        .map((n) => ({
          id: n.id,
          title: this.displayTitle(n),
          trashedAt: n.trashedAt,
          trashId: n.trashId,
        })),
      inbox,
      inboxPage,
      chats: chats.items,
      chatPage: chats.page,
      chatChannels: chats.channels,
      today: todayItems,
      layout: this.layout(profile),
      settings,
      startedAt: this.setting('startedAt'),
      now: current,
      access: {
        role: 'owner',
        label: 'Доступ руководителя Мастерской',
        layout: 'Личная раскладка этого браузера',
      },
      notifications: [],
      counts: {
        inbox: inboxTotal,
        chats: this.db
          .prepare(
            'SELECT count(DISTINCT c.chat_id) AS n FROM sales_events e JOIN sales_event_chats c ON c.event_id=e.id WHERE NOT EXISTS(SELECT 1 FROM sales_links l WHERE l.event_id=e.id)',
          )
          .get().n,
        notes: notes.filter((n) => !terminalNote(n)).length,
      },
    };
  }
  ingest(event) {
    fields(event, [
      'source',
      'account',
      'nativeId',
      'version',
      'conversationId',
      'sourceChatId',
      'occurredAt',
      'observedAt',
      'type',
      'direction',
      'title',
      'url',
      'historical',
      'deleted',
      'contentHash',
      'gap',
    ]);
    for (const k of ['source', 'account', 'nativeId', 'version'])
      text(event[k], 500, true);
    const id = salesHash([event.source, event.account, event.nativeId]);
    // Persist identifiers and fingerprints, never the full text of correspondence.
    const data = {
      source: text(event.source, 40, true),
      account: text(event.account, 200, true),
      nativeId: text(event.nativeId, 500, true),
      conversationId: text(event.conversationId || '', 500),
      sourceChatId: text(event.sourceChatId || '', 500),
      occurredAt: date(event.occurredAt),
      observedAt: date(event.observedAt || timestamp(this.now)),
      type: text(event.type || 'message', 40),
      direction: pick(event.direction || 'unknown', ['in', 'out', 'unknown']),
      title: text(event.title || 'Новое событие', 250),
      url: text(event.url || '', 1000),
      historical: Boolean(event.historical),
      deleted: Boolean(event.deleted),
      contentHash: text(event.contentHash || '', 64),
      gap: Boolean(event.gap),
      owner: 'Руководитель',
      state: 'pending',
    };
    if (
      data.url &&
      !/^https:\/\/(?:www\.)?(?:avito\.ru|web\.max\.ru|mail\.ru|e\.mail\.ru|t\.me)(?:\/|$)/.test(
        data.url,
      )
    )
      fail('Недопустимая ссылка источника.');
    return this.db.transaction(() => {
      const old = this.db
        .prepare('SELECT * FROM sales_events WHERE id=?')
        .get(id);
      const previous = old ? JSON.parse(old.data) : null;
      if (previous?.observedAt && data.observedAt < previous.observedAt)
        return { id, duplicate: true, older: true };
      if (old?.version === event.version) {
        this.db
          .prepare('UPDATE sales_events SET data=? WHERE id=?')
          .run(
            JSON.stringify({ ...previous, observedAt: data.observedAt }),
            id,
          );
        return { id, duplicate: true };
      }
      const at = timestamp(this.now);
      this.db
        .prepare(
          'INSERT INTO sales_events VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,revision=excluded.revision,data=excluded.data,received_at=excluded.received_at',
        )
        .run(
          id,
          data.source,
          data.account,
          data.nativeId,
          event.version,
          (old?.revision || 0) + 1,
          JSON.stringify(data),
          at,
        );
      this.db
        .prepare(
          'INSERT INTO sales_event_chats VALUES(?,?) ON CONFLICT(event_id) DO UPDATE SET chat_id=excluded.chat_id',
        )
        .run(id, salesChatId(data));
      this.db
        .prepare(
          'INSERT OR IGNORE INTO sales_event_versions(event_id,version,data,at) VALUES(?,?,?,?)',
        )
        .run(id, event.version, JSON.stringify(data), at);
      // With several active projects in a chat, leave new messages for explicit routing.
      if (!old) {
        const notes = this.chatNotes(salesChatId(data)).filter(
          (n) => !terminalNote(n),
        );
        if (notes.length === 1)
          this.db
            .prepare('INSERT OR IGNORE INTO sales_links VALUES(?,?)')
            .run(id, notes[0].id);
      }
      for (const link of this.db
        .prepare('SELECT note_id FROM sales_links WHERE event_id=?')
        .all(id)) {
        this.enqueueAutoAnalysis(link.note_id);
        this.audit(
          link.note_id,
          'Источник',
          old ? 'event.changed' : 'event.received',
          { eventId: id, version: event.version },
        );
      }
      return { id, duplicate: false };
    })();
  }
  merge(data, actor, commandId) {
    fields(data, [
      'sourceId',
      'sourceRevision',
      'targetId',
      'targetRevision',
      'resolution',
      'approvedFile',
    ]);
    if (data.sourceId === data.targetId) fail('Выберите две разные записки.');
    const source = this.note(data.sourceId),
      target = this.note(data.targetId);
    this.expect(source, data.sourceRevision);
    this.expect(target, data.targetRevision);
    this.writable(source);
    this.writable(target);
    const resolution = this.validateNote(data.resolution);
    if (
      ![
        'title',
        'owner',
        'client',
        'status',
        'waitingFor',
        'reviewAt',
        'orderId',
        'manual',
      ].every((k) => Object.hasOwn(resolution, k))
    )
      fail('Проверьте итоговые поля объединённого обращения.');
    if (resolution.status === 'archived')
      fail('Объединённая записка должна остаться активной.');
    if (
      resolution.status === 'waiting' &&
      (!resolution.waitingFor || !resolution.reviewAt)
    )
      fail('Укажите контроль ожидания.');
    const approvals = [source.approvedFile, target.approvedFile].filter(
      Boolean,
    );
    let approvedFile = approvals[0] || null;
    if (new Set(approvals).size > 1) {
      if (!approvals.includes(data.approvedFile))
        fail('Выберите согласованный файл для объединённого обращения.');
      approvedFile = data.approvedFile;
    } else if (data.approvedFile != null && data.approvedFile !== approvedFile)
      fail('Нельзя изменить согласование при объединении.');
    const sourceTasks = this.tasks(source.id),
      sourceFiles = this.files(source.id),
      links = this.events(source.id).map((e) => e.id),
      targetLinks = this.events(target.id).map((e) => e.id);
    const moved = [];
    for (const task of sourceTasks)
      moved.push(this.putTask({ ...task, noteId: target.id }));
    this.db
      .prepare(
        'UPDATE sales_files SET note_id=?,revision=revision+1 WHERE note_id=?',
      )
      .run(target.id, source.id);
    this.db
      .prepare(
        'INSERT OR IGNORE INTO sales_links SELECT event_id,? FROM sales_links WHERE note_id=?',
      )
      .run(target.id, source.id);
    this.db.prepare('DELETE FROM sales_links WHERE note_id=?').run(source.id);
    const afterTarget = this.putNote({
      ...target,
      ...resolution,
      titleEdited: true,
      approvedFile,
      summary: null,
    });
    const afterSource = this.putNote({
      ...source,
      status: 'merged',
      approvedFile: null,
      mergedInto: target.id,
    });
    this.db.prepare('INSERT INTO sales_merges VALUES(?,?,?,?,0)').run(
      commandId,
      target.id,
      source.id,
      JSON.stringify({
        source,
        target,
        sourceTasks,
        sourceFiles,
        links,
        moved,
        afterTarget,
        afterSource,
        targetLinks,
      }),
    );
    this.audit(target.id, actor, 'notes.merge', {
      sourceId: source.id,
      mergeId: commandId,
      before: target,
      after: afterTarget,
    });
    this.audit(source.id, actor, 'notes.merge', {
      targetId: target.id,
      mergeId: commandId,
    });
    this.enqueueAutoAnalysis(target.id);
    return { noteId: target.id, mergeId: commandId };
  }
  unmerge(data, actor) {
    fields(data, ['mergeId']);
    const row = this.db
      .prepare('SELECT * FROM sales_merges WHERE id=?')
      .get(data.mergeId);
    if (!row || row.undone)
      fail('Объединение не найдено или уже отменено.', 'SALES_NOT_FOUND', 404);
    const saved = JSON.parse(row.data),
      source = this.note(row.source_id),
      target = this.note(row.target_id);
    this.expect(source, saved.afterSource.revision);
    this.expect(target, saved.afterTarget.revision);
    const expectedLinks = [
      ...new Set([...saved.links, ...saved.targetLinks]),
    ].sort((a, b) => a.localeCompare(b));
    if (
      this.events(source.id).length ||
      JSON.stringify(
        this.events(target.id)
          .map((e) => e.id)
          .sort((a, b) => a.localeCompare(b)),
      ) !== JSON.stringify(expectedLinks)
    )
      fail(
        'После объединения поступили новые сообщения. Используйте разделение, чтобы выбрать их обращение.',
        'SALES_CONFLICT',
        409,
      );
    for (const t of saved.moved) this.expect(this.task(t.id), t.revision);
    for (const t of saved.sourceTasks)
      this.putTask({ ...t, revision: this.task(t.id).revision });
    for (const f of saved.sourceFiles)
      this.db
        .prepare(
          'UPDATE sales_files SET note_id=?,revision=revision+1 WHERE id=?',
        )
        .run(source.id, f.id);
    for (const id of saved.links) {
      this.db
        .prepare('INSERT OR IGNORE INTO sales_links VALUES(?,?)')
        .run(id, source.id);
      if (!saved.targetLinks.includes(id))
        this.db
          .prepare('DELETE FROM sales_links WHERE event_id=? AND note_id=?')
          .run(id, target.id);
    }
    this.putNote({ ...saved.source, revision: source.revision });
    this.putNote({ ...saved.target, revision: target.revision });
    this.db.prepare('UPDATE sales_merges SET undone=1 WHERE id=?').run(row.id);
    this.audit(source.id, actor, 'notes.unmerge', { mergeId: row.id });
    this.audit(target.id, actor, 'notes.unmerge', { mergeId: row.id });
    return { noteId: source.id };
  }
  split(data, actor) {
    fields(data, [
      'id',
      'revision',
      'newNote',
      'taskIds',
      'eventIds',
      'fileIds',
    ]);
    const source = this.note(data.id);
    this.writable(source);
    this.expect(source, data.revision);
    if (data.taskIds?.length)
      fail('Задачи удалены из рабочего стола.', 'SALES_REMOVED', 410);
    data = { ...data, taskIds: [] };
    for (const key of ['taskIds', 'eventIds', 'fileIds'])
      if (
        !Array.isArray(data[key]) ||
        new Set(data[key]).size !== data[key].length
      )
        fail('Проверьте выбранные элементы.');
    const ownTasks = this.tasks(source.id),
      ownEvents = this.events(source.id),
      ownFiles = this.files(source.id);
    for (const [key, items] of [
      ['taskIds', ownTasks],
      ['eventIds', ownEvents],
      ['fileIds', ownFiles],
    ])
      if (data[key].some((id) => !items.some((i) => i.id === id)))
        fail('Выбранный элемент уже изменён.', 'SALES_CONFLICT', 409);
    if (!data.taskIds.length && !data.eventIds.length && !data.fileIds.length)
      fail('Выберите хотя бы один элемент для разделения.');
    const target = this.createNote(data.newNote, actor);
    for (const id of data.taskIds)
      this.putTask({ ...this.task(id), noteId: target.id });
    for (const id of data.fileIds)
      this.db
        .prepare(
          'UPDATE sales_files SET note_id=?,revision=revision+1 WHERE id=?',
        )
        .run(target.id, id);
    for (const id of data.eventIds) {
      this.db.prepare('INSERT INTO sales_links VALUES(?,?)').run(id, target.id);
      this.db
        .prepare('DELETE FROM sales_links WHERE event_id=? AND note_id=?')
        .run(id, source.id);
    }
    this.putNote({
      ...source,
      requestTitle: this.displayTitle(source),
      summary: null,
      approvedFile: data.fileIds.includes(source.approvedFile)
        ? null
        : source.approvedFile,
    });
    this.putNote({
      ...target,
      titleEdited: true,
      ...(data.fileIds.includes(source.approvedFile)
        ? { approvedFile: source.approvedFile }
        : {}),
    });
    this.audit(source.id, actor, 'notes.split', {
      targetId: target.id,
      taskIds: data.taskIds,
      eventIds: data.eventIds,
      fileIds: data.fileIds,
    });
    this.audit(target.id, actor, 'notes.split', { sourceId: source.id });
    this.enqueueAutoAnalysis(source.id);
    this.enqueueAutoAnalysis(target.id);
    return { noteId: target.id };
  }
  storedFile(id) {
    const row = this.db.prepare('SELECT * FROM sales_files WHERE id=?').get(id);
    if (!row) fail('Файл не найден.', 'SALES_NOT_FOUND', 404);
    const metadata = JSON.parse(row.data);
    if (metadata.diskName) {
      if (
        !this.filesDirectory ||
        !/^[a-f0-9-]{36}\.bin$/.test(metadata.diskName)
      )
        fail('Файл недоступен.', 'SALES_NOT_FOUND', 404);
      const target = path.join(this.filesDirectory, metadata.diskName),
        stat = fs.lstatSync(target);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== metadata.size
      )
        fail('Файл повреждён.', 'SALES_FILE_INVALID', 503);
      return {
        path: target,
        size: metadata.size,
        name: row.name,
        mime: row.mime,
        hash: row.hash,
      };
    }
    return {
      bytes: row.bytes,
      size: row.bytes.length,
      name: row.name,
      mime: row.mime,
      hash: row.hash,
    };
  }
  upload(
    { requestId, noteId, revision, name, mime, bytes, file },
    actor = 'Руководитель',
  ) {
    if (
      !uid(requestId) ||
      !(file
        ? this.filesDirectory &&
          file.path &&
          file.size > 0 &&
          /^[a-f0-9]{64}$/.test(file.hash)
        : Buffer.isBuffer(bytes) && bytes.length)
    )
      fail('Файл пуст или не удалось его прочитать.');
    name = text(name, 200, true).replace(/[/\\]/g, '_');
    mime = pick(mime, [
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/pdf',
      'application/octet-stream',
    ]);
    const hash = file?.hash || salesHash(bytes),
      inputHash = salesHash([noteId, revision, name, mime, hash, actor]);
    let movedPath;
    try {
      return this.db.transaction(() => {
        const old = this.db
          .prepare('SELECT * FROM sales_commands WHERE id=?')
          .get(requestId);
        if (old) {
          if (old.hash !== inputHash)
            fail('ID загрузки уже использован.', 'SALES_ID_REUSED', 409);
          return JSON.parse(old.result);
        }
        const note = this.note(noteId);
        this.writable(note);
        this.expect(note, revision);
        const id = crypto.randomUUID(),
          at = timestamp(this.now);
        let diskName;
        if (file) {
          fs.mkdirSync(this.filesDirectory, { recursive: true, mode: 0o700 });
          diskName = id + '.bin';
          movedPath = path.join(this.filesDirectory, diskName);
          fs.renameSync(file.path, movedPath);
          if (process.platform !== 'win32') {
            const directory = fs.openSync(this.filesDirectory, 'r');
            try {
              fs.fsyncSync(directory);
            } finally {
              fs.closeSync(directory);
            }
          }
        }
        this.db.prepare('INSERT INTO sales_files VALUES(?,?,?,?,?,?,?,?)').run(
          id,
          noteId,
          name,
          mime,
          hash,
          bytes || Buffer.alloc(0),
          1,
          JSON.stringify({
            ...(file ? { diskName, size: file.size } : {}),
            at,
            source: 'manual',
            by: actor,
          }),
        );
        this.putNote(note);
        const result = { id, name, hash };
        this.audit(note.id, actor, 'file.upload', result);
        this.db
          .prepare('INSERT INTO sales_commands VALUES(?,?,?,?)')
          .run(requestId, inputHash, JSON.stringify(result), at);
        return result;
      })();
    } catch (error) {
      if (movedPath) {
        try {
          fs.unlinkSync(movedPath);
        } catch {
          /* Retain an orphan for maintenance if storage is unavailable. */
        }
      }
      throw error;
    }
  }
  analysisStatus(note) {
    if (terminalNote(note)) return null;
    const job =
      this.db
        .prepare(
          `SELECT state,data FROM sales_jobs WHERE note_id=? AND state IN ('pending','running')
       ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END,at,rowid LIMIT 1`,
        )
        .get(note.id) ||
      this.db
        .prepare(
          'SELECT state,data FROM sales_jobs WHERE note_id=? ORDER BY at DESC,rowid DESC LIMIT 1',
        )
        .get(note.id);
    if (!job || !['pending', 'running', 'error'].includes(job.state))
      return null;
    const data = JSON.parse(job.data);
    return {
      state: job.state,
      automatic: Boolean(data.automatic),
      retrying: Boolean(data.failures),
      dueAt: data.dueAt || null,
    };
  }
  enqueueAutoAnalysis(noteId) {
    const note = this.note(noteId);
    if (terminalNote(note) || !this.events(noteId).length) return;
    const pending = this.db
      .prepare(
        "SELECT * FROM sales_jobs WHERE note_id=? AND state='pending' AND json_extract(data,'$.automatic')=1 ORDER BY at,rowid LIMIT 1",
      )
      .get(noteId);
    const previous = pending ? JSON.parse(pending.data) : {};
    const firstAt = previous.firstAt ?? this.now();
    // Ten quiet seconds coalesce a burst; continuous conversation cannot postpone
    // the first attempt indefinitely. Keep a provider retry's backoff intact.
    const dueAt = Math.max(
      previous.failures ? previous.dueAt : 0,
      Math.min(this.now() + 10000, firstAt + 30000),
    );
    const data = JSON.stringify({
      ...previous,
      automatic: true,
      firstAt,
      dueAt,
    });
    const job =
      pending || this.beginAnalysis(noteId, note.revision, crypto.randomUUID());
    this.db
      .prepare('UPDATE sales_jobs SET revision=?,watermark=?,data=? WHERE id=?')
      .run(note.revision, this.watermark(noteId), data, job.id);
    return job.id;
  }
  beginAnalysis(noteId, revision, id) {
    if (!uid(id)) fail('Нужен ID анализа.');
    const old = this.db.prepare('SELECT * FROM sales_jobs WHERE id=?').get(id);
    if (old) {
      if (old.note_id !== noteId || old.revision !== revision)
        fail('ID анализа уже использован.', 'SALES_ID_REUSED', 409);
      return old;
    }
    const note = this.note(noteId);
    this.writable(note);
    this.expect(note, revision);
    const watermark = this.watermark(noteId);
    const job = {
      id,
      note_id: noteId,
      revision,
      watermark,
      state: 'pending',
      data: '{}',
      at: timestamp(this.now),
    };
    this.db
      .prepare(
        'INSERT INTO sales_jobs VALUES(@id,@note_id,@revision,@watermark,@state,@data,@at)',
      )
      .run(job);
    return job;
  }
  finishAnalysis(job, result, coverage) {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM sales_jobs WHERE id=?')
        .get(job.id);
      if (row?.state === 'done') return { duplicate: true };
      const note = this.note(job.note_id);
      if (
        note.revision !== job.revision ||
        this.watermark(note.id) !== job.watermark ||
        terminalNote(note)
      ) {
        this.db
          .prepare("UPDATE sales_jobs SET state='stale',data=? WHERE id=?")
          .run(
            JSON.stringify({
              ...JSON.parse(job.data || '{}'),
              code: 'ANALYSIS_STALE',
            }),
            job.id,
          );
        return { stale: true };
      }
      fields(result, [
        'summary',
        'changes',
        'sources',
        'proposals', // Ignored for compatibility with an analysis already in flight.
        'requestTitle',
        'orderDraft',
      ]);
      const summary = text(result.summary, 3000, true),
        changes = text(result.changes, 2000);
      const events = this.events(note.id);
      if (
        !Array.isArray(result.sources) ||
        result.sources.some((id) => !events.some((e) => e.id === id))
      )
        fail('Анализ вернул неподтверждённые источники.');
      const read = coverage || {
        processed: events.map((e) => ({
          id: e.id,
          version: e.version,
          revision: e.revision,
        })),
        omitted: [],
        truncated: [],
      };
      if (
        !Array.isArray(read.processed) ||
        read.processed.some(
          (e) =>
            !events.some(
              (current) =>
                current.id === e.id &&
                current.version === e.version &&
                current.revision === e.revision,
            ),
        )
      )
        fail('Изменились обработанные источники.', 'SALES_CONFLICT', 409);
      if (result.sources.some((id) => !read.processed.some((e) => e.id === id)))
        fail('Анализ ссылается на непрочитанный источник.');
      const orderDraft = normalizeOrderDraft(
        result.orderDraft,
        read.processed.map((e) => e.id),
      );
      const requestTitle = result.requestTitle
        ? text(result.requestTitle, 120)
        : '';
      const updated = this.putNote({
        ...note,
        requestTitle:
          requestTitle || orderDraft?.title || note.requestTitle || '',
        summary: {
          text: summary,
          requestTitle,
          orderDraft,
          changes,
          coverage: read,
          partial: Boolean(
            read.omitted.length ||
            read.truncated.length ||
            read.manualTruncated ||
            read.sourcePartial,
          ),
          sources: result.sources,
          watermark: job.watermark,
          at: timestamp(this.now),
          jobId: job.id,
        },
      });
      this.audit(note.id, 'Помощник', 'summary.update', {
        summary: updated.summary,
      });
      // A manual/first analysis may already cover a queued automatic refresh.
      this.db
        .prepare(
          "UPDATE sales_jobs SET state='stale' WHERE note_id=? AND watermark=? AND state='pending' AND json_extract(data,'$.automatic')=1 AND id!=?",
        )
        .run(note.id, job.watermark, job.id);
      this.db
        .prepare("UPDATE sales_jobs SET state='done',data=? WHERE id=?")
        .run(
          JSON.stringify({
            ...JSON.parse(job.data || '{}'),
            summaryAt: updated.summary.at,
          }),
          job.id,
        );
      return { ok: true };
    })();
  }
}
