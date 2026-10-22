import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const paths = new Map([
  ['/', 'prototypes/analytics/index.html'],
  ...[
    'app.mjs',
    'model.mjs',
    'simple.mjs',
    'simple-model.mjs',
    'performance.mjs',
    'performance-model.mjs',
    'real.mjs',
    'real-model.mjs',
    'style.css',
  ].map((name) => [
    '/prototypes/analytics/' + name,
    'prototypes/analytics/' + name,
  ]),
  [
    '/server/analytics/advertising-metrics.mjs',
    'server/analytics/advertising-metrics.mjs',
  ],
]);
export function preview(port = 4318) {
  const server = http.createServer((req, res) => {
    const file = paths.get(new URL(req.url, 'http://localhost').pathname);
    if (!file || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': file.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : file.endsWith('.mjs')
          ? 'text/javascript; charset=utf-8'
          : 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(
      req.method === 'HEAD'
        ? undefined
        : fs.readFileSync(path.join(root, file)),
    );
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve(server)),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const server = await preview(
    Number(process.env.ANALYTICS_PREVIEW_PORT || 4318),
  );
  console.log(
    `Пять концепций: http://127.0.0.1:${server.address().port}/ · только вымышленные данные`,
  );
}
