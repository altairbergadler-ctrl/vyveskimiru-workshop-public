import { spawnSync } from 'node:child_process';
const result = spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { stdio: 'inherit', windowsHide: true });
if (result.status !== 0) throw new Error('Could not configure repository hooks');
console.log('Local pre-commit check enabled for this repository.');
