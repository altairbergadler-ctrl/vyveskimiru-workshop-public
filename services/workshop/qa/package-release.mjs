import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error('Release packaging check failed'); return result.stdout?.trim();
}
if (run('git', ['status', '--porcelain'], true)) throw new Error('Commit changes before packaging a release');
run(process.execPath, [process.env.npm_execpath, 'run', 'check']);
const sha = run('git', ['rev-parse', 'HEAD'], true);
const directory = path.resolve('work/releases'); fs.mkdirSync(directory, { recursive: true });
const archive = path.join(directory, `${sha}.tar.gz`);
run('git', ['archive', '--format=tar.gz', `--output=${archive}`, sha]);
fs.writeFileSync(archive + '.sha256', crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') + '\n');
fs.writeFileSync(archive + '.revision', sha + '\n');
console.log(`Verified release archive: ${archive}`);
