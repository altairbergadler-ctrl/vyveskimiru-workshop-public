#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const G = require('../assets/geometry.js');
const Products = require('../assets/products.js');
const [source, destination, photo] = process.argv.slice(2);
if (!source || !destination) {
  console.error('Usage: node project.cjs project.json output-directory [oriented-photo.png]');
  process.exit(2);
}
try {
  const sourceProject = JSON.parse(fs.readFileSync(source,'utf8').replace(/^\uFEFF/,''));
  const project = sourceProject.version === 2 ? Products.normalizeProject(sourceProject) : sourceProject;
  const report = G.analyze(project);
  let href = '';
  if (photo) {
    const bytes = fs.readFileSync(photo);
    if (bytes.length < 24 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii',12,16)!=='IHDR') throw new Error('CLI background must be an oriented PNG. For JPEG/WebP use the browser editor, or omit the photo to export a transparent geometry SVG.');
    if (bytes.readUInt32BE(16)!==project.image.width_px || bytes.readUInt32BE(20)!==project.image.height_px) throw new Error('PNG dimensions differ from project coordinates. Use the exact source image with its original orientation.');
    href = `data:image/png;base64,${bytes.toString('base64')}`;
  }
  const out = path.resolve(destination);
  fs.mkdirSync(out,{recursive:true});
  const files = [path.join(out,'report.json'),path.join(out,'geometry.svg')];
  if (files.some(f=>fs.existsSync(f))) throw new Error('Output already exists; use a new version directory.');
  fs.writeFileSync(files[0],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  fs.writeFileSync(files[1],G.overlaySvg(project,report,href),{flag:'wx'});
  console.log(JSON.stringify({files,product:report.product,capabilities:report.capabilities,warnings:report.warnings},null,2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
