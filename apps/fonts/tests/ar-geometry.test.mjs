import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseFont,buildLettering} from '../src/ar-geometry.mjs';
import {quadMap,validQuad} from '../dist/assets/photo-warp.mjs';
import {USDZExporter} from 'three/addons/exporters/USDZExporter.js';
import {unzipSync,strFromU8} from 'three/addons/libs/fflate.module.js';
const {fonts}=JSON.parse(await readFile('dist/assets/font-catalog.json','utf8'));
const settings={text:'Н',uppercase:false,height:30,depth:5,faceColor:'#edab43',material:'color',lighting:'plain'};
let totalVertices=0;
for(const item of fonts) {
  const bytes=await readFile('dist/'+item.file),font=parseFont(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),item.weight);
  if(font.tables.fvar?.axes.some(a=>a.tag==='wght'))assert.equal(font.variation.get().wght,item.weight,'selected font weight');
  const model=buildLettering(font,settings);
  assert(Math.abs(model.size.height-.3)<.00015,`${item.family}: height in meters (curve tessellation within 0.15 mm)`);
  assert(Math.abs(model.size.depth-.05)<.00001,`${item.family}: depth in meters`);
  for(const mesh of model.group.children){assert(mesh.material.isMeshStandardMaterial);for(const x of mesh.geometry.attributes.position.array)assert(Number.isFinite(x));totalVertices+=mesh.geometry.attributes.position.count;}
  model.dispose();
  if(item.family==='Montserrat') {
    const ring=buildLettering(font,{...settings,text:'О'});assert(ring.shapes.some(s=>s.holes.length===1),'Letter О preserves its hole');ring.dispose();
    for(const [text,holes] of [['Я',1],['Р',1],['В',2],['Ю',1]]){
      const letter=buildLettering(font,{...settings,text});assert.equal(letter.shapes.reduce((n,s)=>n+s.holes.length,0),holes,`${text}: counter preserved`);letter.dispose();
    }
    assert.throws(()=>buildLettering(font,{...settings,text:'😀'}),/нет символа/);
    assert.throws(()=>buildLettering(font,{...settings,text:'  '}),/Введите/);
    const multiline=buildLettering(font,{...settings,text:'КОФЕ\nЁЖ'});assert(multiline.size.height>.6);
    const ios=multiline.group.clone();ios.rotation.x=-Math.PI/2;ios.updateMatrixWorld(true);
    const usdz=await new USDZExporter().parseAsync(ios,{ar:{anchoring:{type:'plane'},planeAnchoring:{alignment:'vertical'}}});
    const files=unzipSync(usdz),scene=strFromU8(files['model.usda']);
    assert(scene.includes('alignment = "vertical"'));assert(Object.keys(files).filter(n=>n.startsWith('geometries/')).length===2);assert(scene.includes('Letterfaces'));assert(scene.includes('Lettersides'));multiline.dispose();
  }
}
const corners=[{x:20,y:40},{x:410,y:10},{x:370,y:260},{x:70,y:210}],map=quadMap(corners);
assert(validQuad(corners));assert(!validQuad([corners[0],corners[2],corners[1],corners[3]]));
[[0,0],[1,0],[1,1],[0,1]].forEach(([u,v],i)=>{const p=map(u,v);assert(Math.hypot(p.x-corners[i].x,p.y-corners[i].y)<1e-8);});
console.log(JSON.stringify({fonts:fonts.length,totalVertices,checks:['physical dimensions','finite geometry','holes','missing glyph rejection','multiline','vertical USDZ with faces and sides','perspective corners']}));
