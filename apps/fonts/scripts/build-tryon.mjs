import {build} from 'esbuild';
import {readFile, writeFile} from 'node:fs/promises';
await build({entryPoints:['src/ar.mjs'],bundle:true,format:'esm',target:['es2020'],minify:true,legalComments:'eof',outfile:'dist/assets/ar.bundle.js'});
const licenses = await Promise.all([
  ['@google/model-viewer','LICENSE'],['three','LICENSE'],['opentype.js','LICENSE'],['lit','LICENSE'],['@lit/reactive-element','LICENSE'],['lit-html','LICENSE'],['lit-element','LICENSE'],['@monogrid/gainmap-js','LICENSE']
].map(async ([name,file]) => `${name}\n${await readFile(`node_modules/${name}/${file}`,'utf8')}`));
await writeFile('dist/assets/tryon-licenses.txt',licenses.join('\n\n---\n\n'));
