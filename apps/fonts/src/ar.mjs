import '@google/model-viewer';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {USDZExporter} from 'three/addons/exporters/USDZExporter.js';
import {Group} from 'three';
import {parseFont, buildLettering} from './ar-geometry.mjs';

export async function createModel(font, settings) {
  const response = await fetch(font.file);
  if (!response.ok) throw new Error('Не удалось загрузить файл выбранного шрифта.');
  const model = buildLettering(parseFont(await response.arrayBuffer(),font.weight), settings);
  try {
    const data = await new GLTFExporter().parseAsync(model.group, {binary:true});
    // USD's plane anchor uses local +Y as its normal; the GLB wall uses +Z.
    const ios = model.group.clone();ios.rotation.x=-Math.PI/2;
    const iosScene=new Group();iosScene.add(ios);iosScene.updateMatrixWorld(true);
    const usdz = await new USDZExporter().parseAsync(iosScene, {quickLookCompatible:true,
      ar:{anchoring:{type:'plane'},planeAnchoring:{alignment:'vertical'}}});
    return {url:URL.createObjectURL(new Blob([data], {type:'model/gltf-binary'})),
      iosUrl:URL.createObjectURL(new Blob([usdz], {type:'model/vnd.usdz+zip'})), size:model.size};
  } finally {model.dispose();}
}
