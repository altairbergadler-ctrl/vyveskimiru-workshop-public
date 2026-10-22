import {ShapePath, ShapeUtils, ExtrudeGeometry, BufferGeometry, Float32BufferAttribute, MeshStandardMaterial, Mesh, Group, Box3, Vector3} from 'three';
import opentype from 'opentype.js';

export function parseFont(buffer, weight) {
  const font=opentype.parse(buffer);
  if(font.variation && Number.isFinite(weight) && font.tables.fvar?.axes.some(a=>a.tag==='wght'))font.variation.set({wght:weight});
  return font;
}

// OpenType paths use screen coordinates. Flip Y before constructing 3D outlines.
function shapesFromPath(path, factor, offsetX, offsetY) {
  const shape = new ShapePath();
  const x = v => (v + offsetX) * factor, y = v => (-v + offsetY) * factor;
  for (const c of path.commands) {
    if (c.type === 'M') shape.moveTo(x(c.x), y(c.y));
    else if (c.type === 'L') shape.lineTo(x(c.x), y(c.y));
    else if (c.type === 'Q') shape.quadraticCurveTo(x(c.x1), y(c.y1), x(c.x), y(c.y));
    else if (c.type === 'C') shape.bezierCurveTo(x(c.x1), y(c.y1), x(c.x2), y(c.y2), x(c.x), y(c.y));
    else if (c.type === 'Z') shape.currentPath.closePath();
  }
  // Some fonts contain isolated hint/anchor contours. They have no visible area.
  shape.subPaths=shape.subPaths.filter(p=>Math.abs(ShapeUtils.area(p.getPoints(8)))>1e-12);
  if(!shape.subPaths.length)return [];
  const outer=shape.subPaths.reduce((a,b)=>Math.abs(ShapeUtils.area(a.getPoints(8)))>Math.abs(ShapeUtils.area(b.getPoints(8)))?a:b);
  return shape.toShapes(!ShapeUtils.isClockWise(outer.getPoints(8)));
}

export function buildLettering(font, settings) {
  const text = settings.uppercase ? settings.text.toLocaleUpperCase('ru') : settings.text;
  if (!text.trim()) throw new Error('Введите надпись в каталоге.');
  for (const c of text) if (!/\s/u.test(c) && !font.charToGlyphIndex(c)) throw new Error(`В этом шрифте нет символа «${c}». Измените надпись в каталоге.`);
  const reference = font.getPath('Н', 0, 0, 1000).getBoundingBox();
  const refHeight = reference.y2 - reference.y1;
  if (!(refHeight > 0)) throw new Error('Не удалось определить высоту букв этого шрифта.');
  const factor = settings.height / 100 / refHeight;
  const lines = text.split('\n').slice(0,3);
  const shapes = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const path = font.getPath(line, 0, 0, 1000, {kerning:true});
    const bounds = path.getBoundingBox();
    // Reflected composite glyphs (e.g. Я) can wind in the opposite direction.
    // Classify contours per glyph so their counters never become solid faces.
    for(const glyphPath of font.getPaths(line,0,0,1000,{kerning:true}))
      shapes.push(...shapesFromPath(glyphPath, factor, -(bounds.x1 + bounds.x2) / 2, -index * refHeight * 1.32));
  });
  if (!shapes.length) throw new Error('Не удалось построить контуры букв.');
  const contourPoints=shapes.reduce((count,s)=>count+s.getPoints(8).length+s.holes.reduce((n,h)=>n+h.getPoints(8).length,0),0);
  if(contourPoints>25000)throw new Error('Эта надпись слишком сложная для тестового AR. Сократите текст или выберите примерку по фотографии.');
  const geometry = new ExtrudeGeometry(shapes, {depth:settings.depth / 100, bevelEnabled:false, curveSegments:8, steps:1});
  geometry.computeBoundingBox();
  const center = geometry.boundingBox.getCenter(new Vector3());
  geometry.translate(-center.x, -center.y, -geometry.boundingBox.min.z);
  const color = {white:'#f5f4ed',gold:'#c49a42',silver:'#b8c1c5'}[settings.material] || settings.faceColor;
  const metal = ['gold','silver'].includes(settings.material);
  const face = new MeshStandardMaterial({color, roughness:metal ? 0.3 : 0.6, metalness:metal ? 0.75 : 0,
    emissive:settings.lighting === 'face' ? color : '#000000', emissiveIntensity:settings.lighting === 'face' ? 0.3 : 0});
  const side = new MeshStandardMaterial({color:'#454844', roughness:0.65});
  // Single-material meshes are also supported by Apple's USDZ export.
  const group = new Group(); group.name='VyveskiMiru';
  const parts = [];
  [face,side].forEach((material, materialIndex) => {
    const part = new BufferGeometry();
    for (const name of ['position','normal','uv']) {
      const attribute = geometry.getAttribute(name), values=[];
      for (const range of geometry.groups) if (range.materialIndex === materialIndex) {
        const start=range.start*attribute.itemSize,end=(range.start+range.count)*attribute.itemSize;
        for(let i=start;i<end;i++) values.push(attribute.array[i]);
      }
      part.setAttribute(name,new Float32BufferAttribute(values,attribute.itemSize));
    }
    const mesh = new Mesh(part,material);mesh.name=materialIndex ? 'Letter sides' : 'Letter faces';
    group.add(mesh);parts.push(part);
  });
  geometry.dispose();
  const size = new Box3().setFromObject(group).getSize(new Vector3());
  return {group, size:{width:size.x,height:size.y,depth:size.z}, shapes,
    dispose() {parts.forEach(part=>part.dispose());face.dispose();side.dispose();}};
}
