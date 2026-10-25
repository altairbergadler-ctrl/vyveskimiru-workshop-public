import { SalesOrderFiles } from './sales-order-files.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseCookies } from './auth.mjs';
import { SalesError } from './sales-desk.mjs';
import { salesOrderPrefill } from './sales-order.mjs';
import { stageUpload, sendFile } from './file-streams.mjs';

export function salesStatic(response, url, root) {
  if (
    !['/sales', '/sales/', '/sales/app.js', '/sales/styles.css'].includes(
      url.pathname,
    )
  )
    return false;
  const name = url.pathname.endsWith('.js')
    ? 'app.js'
    : url.pathname.endsWith('.css')
      ? 'styles.css'
      : 'index.html';
  response.writeHead(200, {
    'Content-Type': name.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : name.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  fs.createReadStream(path.join(root, 'modules/sales/public', name)).pipe(
    response,
  );
  return true;
}

export function salesHandler({
  desk,
  sources,
  json,
  body,
  secureCookie,
  readOrders,
  creationDirectory,
  mediaStore,
}) {
  const orderFiles = mediaStore
    ? new SalesOrderFiles({
        desk,
        sources,
        mediaStore,
        creationDirectory,
        readOrders,
      })
    : null;
  let uploads = 0;
  return async (request, response, url) => {
    try {
      let profile = parseCookies(request.headers.cookie).sales_layout;
      if (!/^[a-f0-9]{32}$/.test(profile || '')) {
        profile = crypto.randomBytes(16).toString('hex');
        response.setHeader(
          'Set-Cookie',
          `sales_layout=${profile}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secureCookie ? '; Secure' : ''}`,
        );
      }
      const p = url.pathname.slice('/api/sales'.length);
      if (request.method === 'GET') {
        if (p === '' || p === '/') {
          const snapshot = desk.snapshot(profile, {
            cursor: url.searchParams.get('inboxCursor') || '',
            query: url.searchParams.get('inboxQuery') || '',
            titleMatches: sources.matchingChatTitles(
              url.searchParams.get('inboxQuery'),
            ),
            chatCursor: url.searchParams.get('chatCursor') || '',
            channel: url.searchParams.get('channel') || '',
            scope: url.searchParams.get('scope') || 'pending',
          });
          return json(response, 200, {
            ...snapshot,
            chats: sources.describeChats(snapshot.chats),
            channels: sources.channels(),
          });
        }
        if (p === '/receipt') {
          const row = desk.db
            .prepare('SELECT result FROM sales_commands WHERE id=?')
            .get(url.searchParams.get('id'));
          return json(response, 200, {
            found: Boolean(row),
            result: row ? JSON.parse(row.result) : null,
          });
        }
        if (p === '/chat')
          return json(
            response,
            200,
            await sources.chatThread(
              url.searchParams.get('chatId'),
              Number(url.searchParams.get('offset') || 0),
            ),
          );
        if (p === '/history')
          return json(
            response,
            200,
            await sources.history(
              url.searchParams.get('chatId') || '',
              Number(url.searchParams.get('offset') || 0),
            ),
          );
        if (p === '/note')
          return json(response, 200, desk.detail(url.searchParams.get('id')));
        if (p === '/note-media')
          return json(
            response,
            200,
            await sources.media.note(
              url.searchParams.get('noteId'),
              Number(url.searchParams.get('offset') || 0),
            ),
          );
        if (p === '/media') {
          const file = await sources.media.file(url.searchParams, {
            stream: true,
          });
          return await sendFile(request, response, file, {
            inline:
              /^(image|audio|video)\//.test(file.mime) &&
              url.searchParams.get('download') !== '1',
          });
        }
        if (p === '/source')
          return json(
            response,
            200,
            await sources.media.event(url.searchParams.get('id')),
          );
        if (p === '/order-prepare')
          return json(
            response,
            200,
            sources.orderPreparation({
              noteId: url.searchParams.get('noteId'),
              requestId: url.searchParams.get('requestId'),
            }),
          );
        if (p === '/order-draft')
          return json(
            response,
            200,
            salesOrderPrefill(
              desk,
              url.searchParams.get('noteId'),
              url.searchParams.get('summaryId'),
              { journalDir: creationDirectory },
            ),
          );
        if (p === '/orders')
          return json(response, 200, {
            orders: (await readOrders()).orders.map((o) => ({
              id: o.id,
              title: o.title,
              client: o.client,
              status: o.status,
              dueDate: o.dueDate,
            })),
          });
        if (p === '/file')
          return await sendFile(
            request,
            response,
            desk.storedFile(url.searchParams.get('id')),
          );
        if (p === '/split-preview') {
          const note = desk.detail(url.searchParams.get('noteId')),
            offset = Number(url.searchParams.get('offset') || 0);
          if (!Number.isSafeInteger(offset) || offset < 0 || offset % 20)
            throw new SalesError('SALES_INPUT', 'Некорректная страница.');
          const events = [...note.events].sort((a, b) =>
            (b.occurredAt || b.receivedAt).localeCompare(
              a.occurredAt || a.receivedAt,
            ),
          );
          const items = [],
            cache = new Map();
          for (const event of events.slice(offset, offset + 20)) {
            let text = '';
            try {
              text = (await sources.content(event.id, cache)).text.slice(
                0,
                1200,
              );
            } catch {
              /* Explicit unavailable fallback in UI. */
            }
            items.push({ ...event, text });
          }
          return json(response, 200, {
            items,
            nextOffset: offset + 20 < events.length ? offset + 20 : null,
          });
        }
      }
      if (request.method === 'POST') {
        if (p === '/chat/send')
          return json(
            response,
            200,
            await sources.sendChat(await body(request, 8192)),
          );
        if (p === '/chat/resolve')
          return json(
            response,
            200,
            sources.resolveSend(await body(request, 4096)),
          );
        if (p === '/command') {
          const input = await body(request, 64 * 1024);
          // An existing Google order is linked by exact ID; money is never copied.
          const candidate =
            input.action === 'note.create'
              ? input.data?.orderId
              : input.action === 'note.update'
                ? input.data?.patch?.orderId
                : input.action === 'notes.merge'
                  ? input.data?.resolution?.orderId
                  : input.data?.newNote?.orderId;
          if (
            candidate &&
            !(await readOrders()).orders.some((o) => String(o.id) === candidate)
          )
            throw new SalesError(
              'SALES_ORDER_NOT_FOUND',
              'Такого заказа нет в текущем источнике Google.',
              409,
            );
          const result = desk.command(input, 'Руководитель', profile);
          if (input.action === 'chat.create') void sources.resumeAnalysis();
          return json(response, 200, result);
        }
        if (p === '/history')
          return json(
            response,
            200,
            await sources.remember(await body(request, 4096)),
          );
        if (p === '/sync') return json(response, 202, sources.sync());
        if (p === '/order-files' && orderFiles)
          return json(
            response,
            200,
            await orderFiles.step(await body(request, 4096)),
          );
        if (p === '/order-prepare')
          return json(
            response,
            202,
            sources.prepareOrder(await body(request, 4096)),
          );
        if (p === '/analyze')
          return json(
            response,
            202,
            sources.analyze(await body(request, 4096)),
          );
        if (p === '/file') {
          if (uploads >= 3)
            throw new SalesError(
              'SALES_UPLOAD_BUSY',
              'Другие файлы загружаются. Повторите чуть позже.',
              429,
            );
          uploads++;
          let file;
          try {
            file = await stageUpload(request, desk.filesDirectory);
            return json(
              response,
              200,
              desk.upload({
                requestId: request.headers['x-request-id'],
                noteId: request.headers['x-note-id'],
                revision: Number(request.headers['x-note-revision']),
                name: decodeURIComponent(request.headers['x-file-name'] || ''),
                mime:
                  request.headers['content-type'] || 'application/octet-stream',
                file,
              }),
            );
          } finally {
            uploads--;
            await file?.dispose();
          }
        }
      }
      return json(response, 404, { error: 'Не найдено' });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const safe = error instanceof SalesError;
      return json(
        response,
        safe ? error.statusCode : error instanceof SyntaxError ? 400 : 503,
        {
          error: safe
            ? error.message
            : 'Операция недоступна. Данные сохранены; повторите с прежним ID.',
          code: safe ? error.code : 'SALES_UNAVAILABLE',
          ...(safe && error.current ? { current: error.current } : {}),
        },
      );
    }
  };
}
