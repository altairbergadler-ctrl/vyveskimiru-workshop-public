import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Keep the initial debt visible and exact; new diagnostics always fail.
// A changed source line cannot silently inherit an old exception.
const roots = ['app', 'components', 'hooks', 'lib', 'src', 'server', 'modules/orders/server', 'modules/orders/public', 'modules/sales/public', 'public', 'qa', 'deploy', 'prototypes/analytics', 'vite.config.ts'];
const bin = path.resolve('node_modules/oxlint/bin/oxlint');
const run = spawnSync(process.execPath, [bin, ...roots, '--format', 'json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
if (run.error || !run.stdout) throw new Error('Linter could not run');
const report = JSON.parse(run.stdout);
if (!Array.isArray(report.diagnostics)) throw new Error('Unexpected lint report');
function key(d) {
  const filename = d.filename.replaceAll('\\', '/');
  const line = fs.readFileSync(filename, 'utf8').split(/\r?\n/)[d.labels[0]?.span?.line - 1] ?? '';
  const source = crypto.createHash('sha256').update(line.trim()).digest('hex');
  return { filename, code: d.code, message: d.message, source };
}
const current = report.diagnostics.map(key);
const baselineFile = 'qa/lint-baseline.json';
if (process.argv.includes('--record-baseline')) {
  fs.writeFileSync(baselineFile, JSON.stringify(current, null, 2) + '\n');
  console.log(`Recorded ${current.length} existing diagnostics; review this file in Git.`);
} else {
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')).map(v => JSON.stringify(v));
  const added = current.filter(v => { const i = baseline.indexOf(JSON.stringify(v)); if (i < 0) return true; baseline.splice(i, 1); return false; });
  for (const d of added) console.error(`${d.filename}: ${d.code}: ${d.message}`);
  console.log(`Lint: ${roots.length} source areas, ${current.length - added.length} existing diagnostics, ${added.length} new, ${baseline.length} resolved.`);
  if (added.length || (run.status !== 0 && !report.diagnostics.length)) process.exitCode = 1;
}
