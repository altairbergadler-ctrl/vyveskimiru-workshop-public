import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'work/validation/analytics-public/site');
const files = [
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
  ].map((f) => 'prototypes/analytics/' + f),
  'server/analytics/advertising-metrics.mjs',
];
const versionHash = crypto.createHash('sha256');
for (const file of [...files, 'prototypes/analytics/index.html'])
  versionHash.update(fs.readFileSync(path.join(root, file)));
const prefix = 'v/' + versionHash.digest('hex').slice(0, 16);
const bundle = path.join(out, prefix);
fs.mkdirSync(bundle, { recursive: true });
for (const file of files) {
  fs.mkdirSync(path.dirname(path.join(bundle, file)), { recursive: true });
  fs.copyFileSync(path.join(root, file), path.join(bundle, file));
}
const html = fs
  .readFileSync(path.join(root, 'prototypes/analytics/index.html'), 'utf8')
  .replace(
    '/prototypes/analytics/style.css',
    './' + prefix + '/prototypes/analytics/style.css',
  )
  .replace('/prototypes/analytics/app.mjs', './' + prefix + '/entry.mjs')
  .replace(
    'Мастерская · Пять взглядов на аналитику',
    'Мастерская · Демо аналитики',
  )
  .replace(
    '<meta charset="utf-8" />',
    '<meta charset="utf-8" /><meta name="robots" content="noindex,nofollow" />',
  );
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(
  path.join(bundle, 'entry.mjs'),
  "if (!location.hash) history.replaceState(null, '', '#concept=simple');\nawait import('./prototypes/analytics/app.mjs');\n",
);
const manifest = Object.fromEntries(
  [
    ...files.map((file) => prefix + '/' + file),
    'index.html',
    prefix + '/entry.mjs',
  ].map((file) => [
    file,
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(out, file)))
      .digest('hex'),
  ]),
);
fs.writeFileSync(
  path.join(out, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
console.log(
  `Static demo packaged: ${files.length + 2} public assets; no business records included.`,
);
execFileSync('tar', [
  '-czf',
  path.join(root, 'work/validation/analytics-public/analytics-demo.tar.gz'),
  '-C',
  out,
  ...Object.keys(manifest),
  'manifest.json',
]);
