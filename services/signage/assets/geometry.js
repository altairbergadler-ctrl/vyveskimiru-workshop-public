/* Shared browser/Node geometry. Coordinates: original oriented image pixels; world: cm. */
(function (root, factory) {
  const products = typeof module === 'object' && module.exports ? require('./products.js') : root.SignageProducts;
  const facade = typeof module === 'object' && module.exports ? require('./facade-projection.js') : root.SignageFacadeProjection;
  const api = factory(products, facade);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LetterGeometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Products, Facade) {
  'use strict';
  const fail = message => { throw new Error(message); };
  const positive = (v, label) => Number.isFinite(v) && v > 0 ? v : fail(`${label}: требуется число больше нуля.`);
  const point = p => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? p : fail('Некорректная точка [x, y].');
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  function quad(q) {
    if (!Array.isArray(q) || q.length !== 4) fail('Нужны четыре угла по периметру: левый верхний, правый верхний, правый нижний, левый нижний.');
    q.forEach(point);
    const edges = q.map((p, i) => distance(p, q[(i + 1) % 4]));
    const turns = q.map((p, i) => cross(p, q[(i + 1) % 4], q[(i + 2) % 4]));
    const threshold = Math.max(...edges) ** 2 * 1e-6;
    if (Math.min(...edges) <= 1e-6 || !turns.every(v => Math.abs(v) > threshold) || !turns.every(v => v * turns[0] > 0)) fail('Четырёхугольник вырожден или углы указаны не по порядку.');
    return q;
  }
  function inside(p, polygon) {
    const signs = polygon.map((a, i) => cross(a, polygon[(i + 1) % polygon.length], p));
    return signs.every(v => v >= -1e-7) || signs.every(v => v <= 1e-7);
  }
  function apply(h, p) {
    point(p);
    if (isFacadeProjection(h)) {
      validateProjection(h);
      return h.direction === 'inverse' ? apply(h.matrix, lensPoint(h.lens,p,false)) : lensPoint(h.lens,apply(h.matrix,p),true);
    }
    const z = h[6] * p[0] + h[7] * p[1] + h[8];
    if (!Number.isFinite(z) || Math.abs(z) < 1e-10) fail('Точка слишком близка к горизонту проекции.');
    const r = [(h[0] * p[0] + h[1] * p[1] + h[2]) / z, (h[3] * p[0] + h[4] * p[1] + h[5]) / z];
    if (!r.every(Number.isFinite)) fail('Неустойчивая проекция.');
    return r;
  }
  function multiply(a, b) {
    if (isFacadeProjection(a)) {
      if (a.direction !== 'forward' || !Array.isArray(b)) fail('Недопустимая композиция перспективы фасада.');
      return {...a,matrix:multiply(a.matrix,b)};
    }
    return Array.from({length: 9}, (_, i) => [0, 1, 2].reduce((s, k) => s + a[Math.floor(i / 3) * 3 + k] * b[k * 3 + i % 3], 0));
  }
  function inverse(h) {
    if (isFacadeProjection(h)) return {...h,matrix:inverse(h.matrix),direction:h.direction==='forward'?'inverse':'forward'};
    const [a,b,c,d,e,f,g,k,i] = h;
    const r = [e*i-f*k,c*k-b*i,b*f-c*e,f*g-d*i,a*i-c*g,c*d-a*f,d*k-e*g,b*g-a*k,a*e-b*d];
    const det = a*r[0]+b*r[3]+c*r[6];
    if (!Number.isFinite(det) || Math.abs(det) < 1e-14) fail('Калибровка вырождена.');
    return r.map(v => v / det);
  }
  function solve(a, b) {
    const n = b.length, m = a.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let row = col + 1; row < n; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
      if (Math.abs(m[pivot][col]) < 1e-11) fail('Недостаточно независимых точек для перспективы.');
      [m[pivot], m[col]] = [m[col], m[pivot]];
      const scale = m[col][col];
      for (let j = col; j <= n; j++) m[col][j] /= scale;
      for (let row = 0; row < n; row++) if (row !== col) {
        const factor = m[row][col];
        for (let j = col; j <= n; j++) m[row][j] -= factor * m[col][j];
      }
    }
    return m.map(row => row[n]);
  }
  function normalize(points) {
    const mean = [0, 1].map(k => points.reduce((sum, p) => sum + p[k], 0) / points.length);
    const rms = Math.sqrt(points.reduce((sum, p) => sum + distance(p, mean) ** 2, 0) / points.length);
    positive(rms, 'Разброс точек');
    const s = Math.SQRT2 / rms, h = [s, 0, -s * mean[0], 0, s, -s * mean[1], 0, 0, 1];
    return {points: points.map(p => apply(h, p)), h};
  }
  function homography(source, target) {
    quad(source); quad(target);
    const s = normalize(source), t = normalize(target), rows = [], values = [];
    s.points.forEach(([x,y], i) => {
      const [u,v] = t.points[i];
      rows.push([x,y,1,0,0,0,-u*x,-u*y], [0,0,0,x,y,1,-v*x,-v*y]);
      values.push(u,v);
    });
    const h = multiply(multiply(inverse(t.h), [...solve(rows, values), 1]), s.h);
    const divisor = Math.abs(h[8]) > 1e-12 ? h[8] : Math.hypot(...h);
    const result = h.map(v => v / divisor);
    source.forEach((p, i) => { if (distance(apply(result, p), target[i]) > 1e-6 * Math.max(1, ...target.flat().map(Math.abs))) fail('Неустойчивая калибровка.'); });
    return result;
  }
  function safePolygon(h, points) {
    const matrix=isFacadeProjection(h)?h.matrix:h;
    const tested=isFacadeProjection(h)&&h.direction==='inverse'?sampleEdges(points,16).map(p=>lensPoint(h.lens,p,false)):points;
    const denominators = tested.map(p => matrix[6]*p[0]+matrix[7]*p[1]+matrix[8]);
    if (!denominators.every(v => Math.abs(v) > 1e-9 && v * denominators[0] > 0)) fail('Область пересекает горизонт проекции. Уточните плоскость или размещение.');
    return points.map(p => apply(h, p));
  }
  const isFacadeProjection = h => h && !Array.isArray(h) && h.type==='facade_projection_v1';
  function validateProjection(h) {
    if (!['forward','inverse'].includes(h.direction)||!Array.isArray(h.matrix)||h.matrix.length!==9||!h.matrix.every(Number.isFinite)) fail('Некорректная проекция фасада.');
    const l=h.lens;
    if (!l||![l.k,l.cx,l.cy,l.scale].every(Number.isFinite)||l.scale<=0) fail('Некорректная модель объектива.');
  }
  function lensPoint(l,p,distort) {
    const x=p[0]-l.cx,y=p[1]-l.cy,r2=(x*x+y*y)/(l.scale*l.scale),k=l.k;
    let factor;
    if (distort) {
      const d=1-4*k*r2;if (d<=1e-12) fail('Точка достигает перегиба модели объектива.');
      factor=2/(1+Math.sqrt(d));
    } else {
      if(1+k*r2<=1e-8||1-k*r2<=1e-8)fail('Точка достигает разрыва модели объектива.');
      factor=1/(1+k*r2);
    }
    const out=[l.cx+x*factor,l.cy+y*factor];
    if(!out.every(Number.isFinite))fail('Неустойчивая модель объектива.');
    return out;
  }
  function sampleEdges(points,count=24) {
    if(points.length<2)return points.map(p=>[...p]);
    return points.flatMap((a,i)=>Array.from({length:count},(_,n)=>{const b=points[(i+1)%points.length],t=n/count;return [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];}));
  }
  function projectedBoundary(h,points) {return safePolygon(h,sampleEdges(points,32));}
  function sceneCalibration(project) {
    const base=calibrate(project.calibration||{}),settings=project.facade;
    if(!settings?.enabled)return base;
    if(settings.version!==1)fail('Не поддерживается версия перспективы фасада.');
    if(!Facade?.fitLens)fail('Не загружена модель перспективы фасада. Обновите страницу.');
    const width=positive(project.image?.width_px,'Ширина фото'),height=positive(project.image?.height_px,'Высота фото');
    const target=quad(project.target_polygon_px);
    const within=p=>{point(p);if(p[0]<0||p[1]<0||p[0]>width||p[1]>height)fail('Точки фасада должны лежать внутри фото.');return [...p];};
    target.forEach(within);
    const edge=settings.edge_points??[];
    if(!Array.isArray(edge)||edge.length>4)fail('Нужны дополнительные точки четырёх границ фасада.');
    const samples=Array.from({length:4},(_,i)=>edge[i]==null?null:within(edge[i]));
    const fitted=Facade.fitLens({width,height},target,samples,settings.lens_enabled===true);
    const l=fitted.lens,lens={k:l.k,cx:width/2,cy:height/2,scale:Math.max(width,height),width,height};
    const undistorted=target.map(l.undistort);quad(undistorted);
    let matrix,approximate=false,warnings=[...base.warnings,...fitted.warnings];
    if(project.calibration.mode==='rectangle') {
      const corrected=calibrate({...project.calibration,image_points:project.calibration.image_points.map(l.undistort)});
      matrix=corrected.worldToImage;
    } else {
      // One known segment fixes a uniform scale, but cannot recover the metric
      // aspect of an oblique facade. Preserve that segment exactly and label
      // the image-edge aspect assumption instead of inventing a second measure.
      const w=(distance(undistorted[0],undistorted[1])+distance(undistorted[3],undistorted[2]))/2;
      const h=(distance(undistorted[0],undistorted[3])+distance(undistorted[1],undistorted[2]))/2;
      const provisional=homography([[0,0],[w,0],[w,h],[0,h]],undistorted),inv=inverse(provisional);
      const refs=project.calibration.image_points.map(l.undistort).map(p=>apply(inv,p));
      const scale=positive(project.calibration.length_cm,'Длина эталона')/positive(distance(...refs),'Длина эталона в плоскости');
      const anchor=apply(base.imageToWorld,project.calibration.image_points[0]);
      const offset=anchor.map((v,i)=>v-scale*refs[0][i]);
      matrix=multiply(provisional,[1/scale,0,-offset[0]/scale,0,1/scale,-offset[1]/scale,0,0,1]);
      approximate=true;warnings.push('Перспектива по зоне и одному отрезку приблизительная: пропорции плоскости оценены по фото. Для точных пропорций используйте прямоугольный эталон с двумя размерами. Длина заданного отрезка сохранена.');
    }
    // A coplanar reference may be rotated on the wall. The zone supplies the
    // facade direction; a rigid change of axes preserves every metric length
    // and the previous reference origin instead of stretching to a unit quad.
    const referenceTarget=safePolygon(inverse(matrix),undistorted);
    const edgeDirection=referenceTarget[1].map((x,i)=>x-referenceTarget[0][i]);
    const edgeLength=positive(Math.hypot(...edgeDirection),'Направление фасада');
    const cosine=edgeDirection[0]/edgeLength,sine=edgeDirection[1]/edgeLength;
    matrix=multiply(matrix,[cosine,-sine,0,sine,cosine,0,0,0,1]);
    const forward={type:'facade_projection_v1',matrix,lens,direction:'forward'},back=inverse(forward);
    const targetWorld=safePolygon(inverse(matrix),undistorted);quad(targetWorld);
    const top=targetWorld[1].map((v,i)=>v-targetWorld[0][i]),length=positive(Math.hypot(...top),'Верхняя грань зоны');
    const u=top.map(v=>v/length),v=[-u[1],u[0]],local=targetWorld.map(p=>{const d=p.map((x,i)=>x-targetWorld[0][i]);return [d[0]*u[0]+d[1]*u[1],d[0]*v[0]+d[1]*v[1]];});
    const span=axis=>Math.max(...local.map(p=>p[axis]))-Math.min(...local.map(p=>p[axis]));
    const targetBoundary=sampleEdges(undistorted,32).map(l.distort);
    return {worldToImage:forward,imageToWorld:back,lens,worldToUndistorted:matrix,undistortedToWorld:inverse(matrix),
      target_boundary_px:targetBoundary,target_world_cm:targetWorld,
      zone_info:{width_cm:span(0),height_cm:span(1),approximate},
      facade_status:{enabled:true,lens_enabled:settings.lens_enabled===true,lens_applied:fitted.fit.applied,approximate,axis_rotation_deg:Math.atan2(sine,cosine)*180/Math.PI,fit:fitted.fit},warnings:[...new Set(warnings)]};
  }
  function calibrate(spec) {
    const warnings = [], pts = spec.image_points;
    let worldToImage;
    if (spec.mode === 'frontoparallel') {
      if (spec.frontoparallel_assumed !== true) fail('Для одного отрезка явно укажите допущение: плоскость снята почти спереди.');
      if (!Array.isArray(pts) || pts.length !== 2) fail('Отметьте два конца эталона.');
      pts.forEach(point);
      const pixels = distance(...pts);
      if (pixels < 8) fail('Эталон короче 8 пикселей: выберите более длинный отрезок.');
      const ppcm = pixels / positive(spec.length_cm, 'Длина эталона');
      worldToImage = [ppcm,0,0,0,ppcm,0,0,0,1];
      warnings.push('Масштаб приблизительный: предполагаются одна плоскость, вид почти спереди и отсутствие существенного искажения объектива.');
      if (pixels < 50) warnings.push('Короткий эталон: небольшая ошибка выбора концов заметно меняет масштаб.');
    } else if (spec.mode === 'rectangle') {
      quad(pts);
      if (Math.min(...pts.map((p, i) => distance(p, pts[(i+1)%4]))) < 8) fail('Ребро эталона короче 8 пикселей.');
      const w = positive(spec.width_cm, 'Ширина эталона'), h = positive(spec.height_cm, 'Высота эталона');
      worldToImage = homography([[0,0],[w,0],[w,h],[0,h]], pts);
      safePolygon(worldToImage, [[0,0],[w,0],[w,h],[0,h]]);
      warnings.push('Калибровка действует в плоскости прямоугольника; точность зависит от размеров эталона, выбора углов и искажений объектива.');
    } else fail('Неизвестный режим калибровки.');
    return {worldToImage, imageToWorld: inverse(worldToImage), warnings};
  }
  function measure(calibration, points) {
    if (!Array.isArray(points) || points.length !== 2) fail('Замер требует два конца отрезка.');
    return distance(...safePolygon(calibration.imageToWorld, points));
  }
  function rulerPoints(points) {
    if (!Array.isArray(points) || points.length > 256) fail('Линейка допускает не больше 256 точек.');
    for (const p of points) point(p);
    return points;
  }
  function measurePolyline(calibration, points) {
    rulerPoints(points);
    // The denominator of a homography is linear along each segment. Equal,
    // nonzero signs at all vertices rule out a horizon crossing anywhere in
    // this connected chain, even when the segment endpoints look plausible.
    const points_cm = safePolygon(calibration.imageToWorld, points);
    const segment_lengths_cm = [], cumulative_lengths_cm = points.length ? [0] : [];
    let total_cm = 0;
    for (let i = 1; i < points_cm.length; i++) {
      const length = distance(points_cm[i - 1], points_cm[i]);
      total_cm += length;
      if (!Number.isFinite(length) || !Number.isFinite(total_cm)) fail('Неустойчивая проекция линейки.');
      segment_lengths_cm.push(length);
      cumulative_lengths_cm.push(total_cm);
    }
    return {segment_lengths_cm, total_cm, cumulative_lengths_cm, points_cm};
  }
  function placement(calibration, spec) {
    const center = apply(calibration.imageToWorld, point(spec.center_px));
    const w = positive(spec.width_cm, 'Ширина макета'), h = positive(spec.height_cm, 'Высота макета');
    const degrees = spec.rotation_deg ?? 0;
    if (!Number.isFinite(degrees)) fail('Некорректный угол поворота.');
    const rad = degrees * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad);
    const corners = [[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]].map(([x,y]) => [center[0]+x*c-y*s,center[1]+x*s+y*c]);
    const polygon = safePolygon(calibration.worldToImage, corners);
    quad(polygon);
    const result={center_cm:center, corners_cm:corners, polygon_px:polygon};
    if(isFacadeProjection(calibration.worldToImage)){
      const localToWorld=[c,-s,center[0]-w*c/2+h*s/2,s,c,center[1]-w*s/2-h*c/2,0,0,1];
      result.local_to_image=multiply(calibration.worldToImage,localToWorld);
      result.boundary_px=projectedBoundary(calibration.worldToImage,corners);
    }
    return result;
  }
  function textLines(text) {
    const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines;
  }
  function textSettings(sign, envelope) {
    const lines = textLines(sign?.text);
    const width = positive(envelope?.width_cm, 'Ширина композиции');
    const height = positive(envelope?.height_cm, 'Высота композиции');
    const gap = sign?.line_gap_cm ?? 5, align = sign?.text_align ?? 'center';
    if (!Number.isFinite(gap) || gap < 0) fail('Межстрочный зазор должен быть числом не меньше нуля.');
    if (!['left', 'center', 'right'].includes(align)) fail('Неизвестное выравнивание строк.');
    if (lines.length && (lines.length - 1) * gap >= height) fail('Межстрочные зазоры занимают всю высоту композиции. Увеличьте высоту или уменьшите зазор.');
    return {lines, width, height, gap, align};
  }
  function legacyTextLayout(sign, envelope, measure) {
    const {lines, width, height, gap, align} = textSettings(sign, envelope);
    if (!lines.length) fail('Введите текст надписи.');
    const saved = sign.preview_line_metrics;
    const referenceSize = measure ? 100 : positive(saved?.font_size_px, 'Размер шрифта замера');
    if (!measure && (!Array.isArray(saved?.lines) || saved.lines.length !== lines.length || saved.lines.some((m, i) => m.text !== lines[i]))) fail('Метрики шрифта не соответствуют строкам. Откройте проект в редакторе для повторного замера.');
    const metrics = lines.map((text, i) => {
      const m = measure ? measure(text) : saved.lines[i];
      const values = ['width', 'actualBoundingBoxAscent', 'actualBoundingBoxDescent', 'actualBoundingBoxLeft', 'actualBoundingBoxRight'];
      if (!m || !values.every(key => Number.isFinite(m[key])) || m.width < 0) fail('Некорректные метрики шрифта.');
      const inkWidth = (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) / referenceSize;
      const inkHeight = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / referenceSize;
      const blank = !text.trim();
      if (!blank && (inkWidth <= 0 || inkHeight <= 0)) fail('Не удалось измерить видимые границы строки.');
      return {text, blank, width: blank ? 0 : inkWidth, height: blank ? 0 : inkHeight,
        left: m.actualBoundingBoxLeft / referenceSize, ascent: m.actualBoundingBoxAscent / referenceSize};
    });
    const nominalHeight = Math.max(...metrics.map(m => m.height));
    const maxWidth = Math.max(...metrics.map(m => m.width));
    const totalHeight = metrics.reduce((sum, m) => sum + (m.blank ? nominalHeight : m.height), 0);
    const fontSize = Math.min(width / maxWidth, (height - (lines.length - 1) * gap) / totalHeight);
    positive(fontSize, 'Размер шрифта композиции');
    const contentHeight = totalHeight * fontSize + (lines.length - 1) * gap;
    let top = (height - contentHeight) / 2;
    const rows = metrics.map(m => {
      const rowWidth = m.width * fontSize, rowHeight = (m.blank ? nominalHeight : m.height) * fontSize;
      const left = align === 'left' ? 0 : align === 'right' ? width - rowWidth : (width - rowWidth) / 2;
      const row = {text: m.text, blank: m.blank, x_cm: left + m.left * fontSize,
        y_cm: top, baseline_cm: top + m.ascent * fontSize,
        width_cm: rowWidth, height_cm: rowHeight,
        bounds_cm: [[left, top], [left + rowWidth, top], [left + rowWidth, top + rowHeight], [left, top + rowHeight]]};
      top += rowHeight + gap;
      return row;
    });
    return {lines: rows, font_size_cm: fontSize, line_gap_cm: gap, text_align: align,
      width_cm: width, height_cm: height, content_width_cm: maxWidth * fontSize,
      content_height_cm: contentHeight, font_family: measure ? 'Arial' : (saved.font_family || 'Arial'),
      font_weight: measure ? 700 : (saved.font_weight || 700), metric_source: 'measured_preview_font'};
  }
  function textLayout(sign, envelope, measure) {
    if (sign?.objects !== undefined) return objectsLayout(sign, envelope, measure);
    // Preserve the original fitting contract for projects without composition
    // controls. New controls use physical ink-box heights, never silently
    // shrinking a height explicitly supplied in centimetres.
    if (sign?.line_styles === undefined && !sign?.logo) return legacyTextLayout(sign, envelope, measure);
    const {lines, width, height, gap, align} = textSettings(sign, envelope);
    const supplied = sign.line_styles;
    if (supplied !== undefined && (!Array.isArray(supplied) || supplied.length !== lines.length)) fail('Настройки строк не соответствуют тексту. Обновите строки в редакторе.');
    const styles = lines.map((text, index) => {
      const style = supplied !== undefined ? supplied[index] : {height_cm:null,font_family:sign.font_family || 'Arial',font_bold:sign.font_bold !== false};
      if (!style || typeof style !== 'object' || Array.isArray(style)) fail(`Проверьте настройки строки ${index + 1}.`);
      if (style.height_cm !== null) positive(style.height_cm, `Высота строки ${index + 1}`);
      if (typeof style.font_family !== 'string' || !style.font_family.trim() || style.font_family.length > 4000 || typeof style.font_bold !== 'boolean') fail(`Укажите шрифт и начертание строки ${index + 1}.`);
      return {...style,font_family:style.font_family.trim()};
    });
    let logo = null;
    const textBox = {x_cm:0,y_cm:0,width_cm:width,height_cm:height};
    if (sign.logo) {
      const spec = sign.logo;
      if (typeof spec !== 'object' || Array.isArray(spec)) fail('Проверьте настройки логотипа.');
      if (!Products) fail('Не загружен модуль проверки оригинала логотипа.');
      const info = Products.artworkInfo(spec.artwork);
      const logoWidth = positive(spec.width_cm, 'Ширина логотипа'), logoHeight = logoWidth * info.height_px / info.width_px;
      const x = spec.x_cm, y = spec.y_cm;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) fail('Положение логотипа: координаты от левого верхнего угла должны быть не меньше нуля.');
      if (x+logoWidth > width+1e-7 || y+logoHeight > height+1e-7) fail('Логотип не помещается в габарит композиции. Измените его положение или ширину.');
      logo = {x_cm:x,y_cm:y,width_cm:logoWidth,height_cm:logoHeight,
        data_url:spec.artwork.data_url,name:spec.artwork.name,
        bounds_cm:[[x,y],[x+logoWidth,y],[x+logoWidth,y+logoHeight],[x,y+logoHeight]]};
    }
    if (!lines.length) {
      if (!logo) fail('Введите текст надписи или добавьте логотип.');
      return {lines:[],logo,font_size_cm:0,line_gap_cm:gap,text_align:align,width_cm:width,height_cm:height,
        content_width_cm:logo.width_cm,content_height_cm:logo.height_cm,text_box_cm:textBox,
        font_family:sign.font_family || 'Arial',font_weight:sign.font_bold === false ? 400 : 700,metric_source:'measured_preview_font'};
    }
    const saved = sign.preview_line_metrics;
    const referenceSize = measure ? 100 : positive(saved?.font_size_px, 'Размер шрифта замера');
    if (!measure && (!Array.isArray(saved?.lines) || saved.lines.length !== lines.length || saved.lines.some((m, i) => m.text !== lines[i]))) fail('Метрики шрифта не соответствуют строкам. Откройте проект в редакторе для повторного замера.');
    const metrics = lines.map((text, index) => {
      const style = styles[index], m = measure ? measure(text,index,style) : saved.lines[index];
      const values = ['width','actualBoundingBoxAscent','actualBoundingBoxDescent','actualBoundingBoxLeft','actualBoundingBoxRight'];
      if (!m || !values.every(key => Number.isFinite(m[key])) || m.width < 0) fail('Некорректные метрики шрифта.');
      const weight = style.font_bold ? 700 : 400;
      if (!measure && (m.font_family !== style.font_family || m.font_weight !== weight)) fail(`Метрики шрифта строки ${index + 1} устарели. Откройте проект в редакторе для повторного замера.`);
      const blank = !text.trim(), inkWidth = (m.actualBoundingBoxLeft+m.actualBoundingBoxRight)/referenceSize,
        inkHeight = (m.actualBoundingBoxAscent+m.actualBoundingBoxDescent)/referenceSize;
      if (!Number.isFinite(inkWidth) || !Number.isFinite(inkHeight)) fail('Некорректные метрики шрифта.');
      if (!blank && (inkWidth <= 0 || inkHeight <= 0)) fail('Не удалось измерить видимые границы строки.');
      return {text,blank,width:blank?0:inkWidth,height:blank?0:inkHeight,left:m.actualBoundingBoxLeft/referenceSize,
        ascent:m.actualBoundingBoxAscent/referenceSize,style,font_family:style.font_family,font_weight:weight};
    });
    const nominalHeight = Math.max(...metrics.map(m => m.height));
    const exactHeight = metrics.reduce((total,m) => total+(m.style.height_cm ?? 0),0), gapTotal = (lines.length-1)*gap;
    const availableHeight = textBox.height_cm-gapTotal-exactHeight;
    const automatic = metrics.filter(m => m.style.height_cm === null);
    if (availableHeight < -1e-7 || (automatic.length && availableHeight <= 0)) fail('Высоты строк и межстрочные зазоры не помещаются в композицию. Увеличьте габарит или уменьшите заданные высоты.');
    const autoHeight = automatic.reduce((sum,m) => sum+(m.blank?nominalHeight:m.height),0);
    const autoWidth = Math.max(0,...automatic.map(m=>m.width));
    const autoFontSize = automatic.length ? Math.min(autoWidth?textBox.width_cm/autoWidth:Infinity,availableHeight/autoHeight) : 0;
    if (automatic.length) positive(autoFontSize, 'Размер автоматических строк');
    const prepared = metrics.map((m,index) => {
      const inkHeight = m.blank ? nominalHeight : m.height;
      const fontSize = m.style.height_cm === null ? autoFontSize : m.style.height_cm/inkHeight;
      const rowWidth = m.width*fontSize, rowHeight = inkHeight*fontSize;
      if (rowWidth > textBox.width_cm+1e-7) fail(`Строка ${index + 1} при заданной высоте не помещается по ширине. Уменьшите высоту или увеличьте габарит.`);
      return {...m,font_size_cm:fontSize,width_cm:rowWidth,height_cm:rowHeight};
    });
    const contentHeight = prepared.reduce((sum,m)=>sum+m.height_cm,0)+gapTotal;
    let top = textBox.y_cm+(textBox.height_cm-contentHeight)/2;
    const rows = prepared.map(m => {
      const left = textBox.x_cm+(align === 'left'?0:align === 'right'?textBox.width_cm-m.width_cm:(textBox.width_cm-m.width_cm)/2);
      const row = {text:m.text,blank:m.blank,x_cm:left+m.left*m.font_size_cm,y_cm:top,
        baseline_cm:top+m.ascent*m.font_size_cm,width_cm:m.width_cm,height_cm:m.height_cm,
        font_size_cm:m.font_size_cm,font_family:m.font_family,font_weight:m.font_weight,
        bounds_cm:[[left,top],[left+m.width_cm,top],[left+m.width_cm,top+m.height_cm],[left,top+m.height_cm]]};
      top += m.height_cm+gap;
      return row;
    });
    const contentWidth = Math.max(...rows.map(m=>m.width_cm));
    return {lines:rows,logo,font_size_cm:autoFontSize || rows[0].font_size_cm,line_gap_cm:gap,text_align:align,
      width_cm:width,height_cm:height,content_width_cm:logo?Math.max(contentWidth,logo.width_cm):contentWidth,
      content_height_cm:logo?Math.max(contentHeight,logo.height_cm):contentHeight,
      text_box_cm:textBox,font_family:rows[0].font_family,font_weight:rows[0].font_weight,metric_source:'measured_preview_font'};
  }
  function letterHeightReference(object) {
    const setting = object.height_reference === undefined ? 'auto' : object.height_reference;
    if (!['auto','uppercase','lowercase'].includes(setting)) fail('Проверьте основу высоты: заглавные или строчные буквы.');
    const text = typeof object.text === 'string' ? object.text : '';
    const letterCase = setting === 'auto' ? (/[\p{Lu}\p{Lt}]/u.test(text) || !/\p{Ll}/u.test(text) ? 'uppercase' : 'lowercase') : setting;
    const cyrillic = /(?=\p{L})\p{Script=Cyrillic}/u.test(text);
    return {letter_case:letterCase,text:letterCase === 'uppercase' ? (cyrillic ? 'Н' : 'H') : (cyrillic ? 'н' : 'x')};
  }

  function independentObjectLayout(object, measure) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) fail('Проверьте настройки объекта.');
    if (typeof object.id !== 'string' || !object.id.trim() || object.id.length > 160) fail('У объекта должен быть постоянный идентификатор.');
    if (!['text','logo'].includes(object.type)) fail('Неизвестный тип объекта композиции.');
    const x = object.x_cm, y = object.y_cm, rotation = object.rotation_deg === undefined ? 0 : object.rotation_deg;
    if (!Number.isFinite(x) || !Number.isFinite(y)) fail('Положение объекта: укажите координаты X и Y в сантиметрах.');
    if (!Number.isFinite(rotation)) fail('Некорректный угол поворота объекта.');
    if (object.depth_cm !== undefined && (!Number.isFinite(object.depth_cm) || object.depth_cm < 0)) fail('Глубина объекта должна быть числом не меньше нуля.');
    if (object.side_color !== undefined && (typeof object.side_color !== 'string' || !/^#[0-9a-f]{6}$/i.test(object.side_color))) fail('Цвет боковины объекта должен быть HEX вида #ffffff.');
    if (object.brief !== undefined && (typeof object.brief !== 'string' || object.brief.length > 4000)) fail('Примечание объекта должно содержать не больше 4000 символов.');
    const common = {id:object.id,type:object.type,x_cm:x,y_cm:y,rotation_deg:rotation,
      ...(object.depth_cm === undefined ? {} : {depth_cm:object.depth_cm}),
      ...(object.side_color === undefined ? {} : {side_color:object.side_color}),
      ...(object.brief === undefined ? {} : {brief:object.brief})};
    let layout;
    if (object.type === 'logo') {
      if (!Products) fail('Не загружен модуль проверки оригинала логотипа.');
      const info = Products.artworkInfo(object.artwork), width = positive(object.width_cm, 'Ширина логотипа');
      const height = positive(width * info.height_px / info.width_px, 'Высота логотипа');
      layout = {...common,width_cm:width,height_cm:height,data_url:object.artwork.data_url,name:object.artwork.name};
    } else {
      if (typeof object.text !== 'string' || object.text.length > 8000) fail('Текст объекта должен содержать не больше 8000 символов.');
      const lines = textLines(object.text);
      if (!lines.length) fail('Введите текст объекта.');
      if (typeof object.font_family !== 'string' || !object.font_family.trim() || object.font_family.length > 4000 || typeof object.font_bold !== 'boolean') fail('Укажите шрифт и начертание текста.');
      const family = object.font_family.trim(), weight = object.font_bold ? 700 : 400;
      const letterHeight = positive(object.letter_height_cm, 'Высота букв объекта'), gap = object.line_gap_cm === undefined ? 0 : object.line_gap_cm, align = object.text_align === undefined ? 'left' : object.text_align;
      // Projects without this versioned setting retain their original full-ink
      // sizing. Body sizing uses a fixed font reference, never the text's tails
      // or accents, while all real outlines remain in the resulting bounds.
      const heightBasis = object.height_basis === undefined ? 'bounds' : object.height_basis;
      if (!['body','bounds'].includes(heightBasis)) fail('Неизвестный способ измерения высоты букв.');
      const heightReference = letterHeightReference(object);
      if (!Number.isFinite(gap) || gap < 0) fail('Межстрочный зазор объекта должен быть числом не меньше нуля.');
      if (!['left','center','right'].includes(align)) fail('Неизвестное выравнивание строк объекта.');
      if (object.front_color !== undefined && (typeof object.front_color !== 'string' || !/^#[0-9a-f]{6}$/i.test(object.front_color))) fail('Лицевой цвет объекта должен быть HEX вида #ffffff.');
      const saved = object.preview_line_metrics;
      if (!measure && (saved?.font_size_px !== 100 || !Array.isArray(saved?.lines) || saved.lines.length !== lines.length || saved.lines.some((m,i) => !m || m.text !== lines[i] || m.font_family !== family || m.font_weight !== weight))) fail('Метрики шрифта объекта устарели. Откройте проект в редакторе для повторного замера.');
      const metrics = lines.map((text,index) => {
        const m = measure ? measure(text,index,object) : saved.lines[index];
        const values = ['width','actualBoundingBoxAscent','actualBoundingBoxDescent','actualBoundingBoxLeft','actualBoundingBoxRight'];
        if (!m || !values.every(key => Number.isFinite(m[key])) || m.width < 0) fail('Некорректные метрики шрифта объекта.');
        const blank = !text.trim(), width = (m.actualBoundingBoxLeft+m.actualBoundingBoxRight)/100, height = (m.actualBoundingBoxAscent+m.actualBoundingBoxDescent)/100;
        if (!Number.isFinite(width) || !Number.isFinite(height) || (!blank && (width <= 0 || height <= 0))) fail('Не удалось измерить видимые границы текста объекта.');
        return {text,blank,width:blank?0:width,height:blank?0:height,left:m.actualBoundingBoxLeft/100,ascent:m.actualBoundingBoxAscent/100};
      });
      let nominalHeight = Math.max(...metrics.map(m => m.height));
      if (heightBasis === 'body') {
        const reference = measure ? measure(heightReference.text,-1,object) : saved.height_reference;
        const keys = ['width','actualBoundingBoxAscent','actualBoundingBoxDescent','actualBoundingBoxLeft','actualBoundingBoxRight'];
        if (!reference || reference.text !== heightReference.text || reference.font_family !== family || reference.font_weight !== weight || !keys.every(key => Number.isFinite(reference[key]))) fail('Метрики основной высоты шрифта устарели. Откройте проект в редакторе для повторного замера.');
        if (reference.width < 0 || reference.actualBoundingBoxLeft+reference.actualBoundingBoxRight <= 0) fail('Не удалось измерить основную высоту шрифта.');
        nominalHeight = positive((reference.actualBoundingBoxAscent+reference.actualBoundingBoxDescent)/100, 'Основная высота шрифта');
      }
      const fontSize = positive(letterHeight/nominalHeight, 'Размер шрифта объекта');
      const width = positive(Math.max(...metrics.map(m => m.width))*fontSize, 'Ширина текста объекта');
      const height = positive(metrics.reduce((sum,m) => sum+(m.blank?nominalHeight:m.height),0)*fontSize+(lines.length-1)*gap, 'Высота текста объекта');
      let top = 0;
      const rows = metrics.map(m => {
        const rowWidth = m.width*fontSize, rowHeight = (m.blank?nominalHeight:m.height)*fontSize;
        const left = align === 'left'?0:align === 'right'?width-rowWidth:(width-rowWidth)/2;
        const row = {text:m.text,blank:m.blank,x_cm:left+m.left*fontSize,y_cm:top,baseline_cm:top+m.ascent*fontSize,
          width_cm:rowWidth,height_cm:rowHeight,font_size_cm:fontSize,font_family:family,font_weight:weight,
          bounds_cm:[[left,top],[left+rowWidth,top],[left+rowWidth,top+rowHeight],[left,top+rowHeight]]};
        top += rowHeight+gap;
        return row;
      });
      layout = {...common,text:object.text,width_cm:width,height_cm:height,lines:rows,font_family:family,font_weight:weight,
        font_size_cm:fontSize,letter_height_cm:letterHeight,line_gap_cm:gap,text_align:align,front_color:object.front_color,
        height_basis:heightBasis,...(heightBasis === 'body' ? {height_reference:heightReference.letter_case,height_reference_text:heightReference.text,body_height_cm:letterHeight} : {}),
        metric_source:'measured_preview_font'};
    }
    const w = layout.width_cm, h = layout.height_cm, radians = rotation*Math.PI/180, c = Math.cos(radians), s = Math.sin(radians);
    const localToComposition = [c,-s,x+w/2-c*w/2+s*h/2,s,c,y+h/2-s*w/2-c*h/2,0,0,1];
    layout.local_bounds_cm = [[0,0],[w,0],[w,h],[0,h]];
    layout.object_to_composition = localToComposition;
    layout.bounds_cm = layout.local_bounds_cm.map(p => apply(localToComposition,p));
    if (layout.lines) layout.lines.forEach(line => { line.composition_bounds_cm = line.bounds_cm.map(p => apply(localToComposition,p)); });
    return layout;
  }
  function objectsLayout(sign, envelope, measure, options = {}) {
    const independent = sign?.composition_mode === 'independent_signs_v1';
    const width = independent ? null : positive(envelope?.width_cm, 'Ширина композиции');
    const height = independent ? null : positive(envelope?.height_cm, 'Высота композиции');
    if (!Array.isArray(sign?.objects) || sign.objects.length > 20) fail('Композиция допускает массив не больше 20 объектов.');
    const preview = options.preview === true, warnings = [], ids = new Set();
    if (preview) {
      // A temporarily empty text still owns its ID. Do not hide malformed scene
      // structure or duplicate identities by omitting an unfinished text object.
      const reserved = new Set();
      sign.objects.forEach(object => {
        if (!object || typeof object !== 'object' || Array.isArray(object)) fail('Проверьте настройки объекта.');
        if (typeof object.id !== 'string' || !object.id.trim() || object.id.length > 160) fail('У объекта должен быть постоянный идентификатор.');
        if (reserved.has(object.id)) fail('Идентификаторы объектов композиции должны быть уникальными.');
        reserved.add(object.id);
      });
    }
    const objects = sign.objects.map((object,index) => {
      let layout;
      try {
        layout = independentObjectLayout(object, measure ? (text,rowIndex,settings) => measure(text,rowIndex,settings,index) : undefined);
      } catch (error) {
        if (!preview || object?.type !== 'text') throw error;
        warnings.push(`Объект ${index+1} временно не показан: ${error.message}`);
        return null;
      }
      if (ids.has(layout.id)) fail('Идентификаторы объектов композиции должны быть уникальными.');
      ids.add(layout.id);
      if (!independent && layout.bounds_cm.some(([x,y]) => x < -1e-7 || y < -1e-7 || x > width+1e-7 || y > height+1e-7)) {
        const message = `Объект ${index+1} не помещается в габарит композиции. Измените его положение, размер или поворот.`;
        if (!preview) fail(message);
        layout.fits_composition = false;
        warnings.push(message);
      }
      return layout;
    }).filter(object => object !== null);
    return {...(independent ? {composition_mode:'independent_signs_v1',coordinate_space:'wall_plane',independent_signs:true} : {width_cm:width,height_cm:height}),
      objects,lines:[],metric_source:'independent_objects',...(preview ? {preview:true,warnings} : {})};
  }
  function independentSignsFromComposition(objects, spec, calibration) {
    // Legacy X/Y belongs to the rotated composition. Transfer each object's
    // center into the calibrated wall plane, retaining its physical dimensions
    // and rotating around its own center after adding the former group angle.
    // Measuring first is essential: a text's ink box determines that center.
    const positioned = placement(calibration, spec);
    const radians = (spec.rotation_deg ?? 0)*Math.PI/180, c = Math.cos(radians), s = Math.sin(radians);
    const w = spec.width_cm, h = spec.height_cm, [cx,cy] = positioned.center_cm;
    const localToWorld = [c,-s,cx-c*w/2+s*h/2,s,c,cy-s*w/2-c*h/2,0,0,1];
    if (!Array.isArray(objects) || objects.length > 20) fail('Композиция допускает массив не больше 20 объектов.');
    const ids = new Set();
    return objects.map(object => {
      const layout = independentObjectLayout(object);
      if (ids.has(layout.id)) fail('Идентификаторы объектов композиции должны быть уникальными.');
      ids.add(layout.id);
      const center = apply(localToWorld,[object.x_cm+layout.width_cm/2,object.y_cm+layout.height_cm/2]);
      return {...object,x_cm:center[0]-layout.width_cm/2,y_cm:center[1]-layout.height_cm/2,
        rotation_deg:layout.rotation_deg+(spec.rotation_deg ?? 0)};
    });
  }
  function independentSignsPlacement(objects) {
    if (!objects.length) return null;
    const world = objects.flatMap(object => object.bounds_cm), image = objects.flatMap(object => object.boundary_px||object.polygon_px);
    const extrema = points => [0,1].map(k => [Math.min(...points.map(p => p[k])),Math.max(...points.map(p => p[k]))]);
    const [[left,right],[top,bottom]] = extrema(world), [[pxLeft,pxRight],[pxTop,pxBottom]] = extrema(image);
    // This is technical scene metadata, never a placement or clipping boundary.
    // An image-space union remains usable even if the gap between disconnected
    // signs crosses a projective horizon; each sign was checked independently.
    return {derived:true,composition_mode:'independent_signs_v1',bounds_space:'image_union',
      width_cm:right-left,height_cm:bottom-top,center_cm:[(left+right)/2,(top+bottom)/2],
      corners_cm:[[left,top],[right,top],[right,bottom],[left,bottom]],
      polygon_px:[[pxLeft,pxTop],[pxRight,pxTop],[pxRight,pxBottom],[pxLeft,pxBottom]],
      fits_target:objects.every(object => object.fits_target)};
  }
  function analyze(project, options = {}) {
    const original = project;
    let product = null;
    if (project.version === 2) {
      if (!Products) fail('Не загружен модуль изделий.');
      product = Products.validateProduct(Products.activeProduct(project));
      project = Products.legacyProject(project);
    } else if (project.version !== 1) fail('Поддерживаются версии проекта 1 и 2.');
    if (project.sign?.objects !== undefined) {
      if (product && Products.renderer(product) !== 'channel_letters') fail('Независимые объекты композиции поддерживаются только для объёмных букв.');
      if (product?.artwork) fail('Композиция объектов и общий оригинал макета не могут одновременно задавать объёмные буквы. Сохраните оригинал отдельным объектом.');
    }
    const independent = project.sign?.composition_mode === 'independent_signs_v1';
    const width = positive(project.image?.width_px, 'Ширина фото'), height = positive(project.image?.height_px, 'Высота фото');
    const within = p => { point(p); if (p[0] < 0 || p[1] < 0 || p[0] > width || p[1] > height) fail('Исходная отметка выходит за размеры фото.'); };
    project.calibration?.image_points?.forEach(within);
    const calibration = sceneCalibration(project), warnings = [...calibration.warnings];
    if(project.wall_calibration?.status==='not_established'||project.placement?.scale_status==='concept_only_from_curb_reference')warnings.push('Концепт: эталон находится на другой глубине. Масштаб вывески на фасаде не подтверждён.');
    let positioned = null, signLayout = null;
    if (independent) {
      const target = project.target_polygon_px ? quad(project.target_polygon_px) : [[0,0],[width,0],[width,height],[0,height]];
      target.forEach(within);
      signLayout = objectsLayout(project.sign,null,undefined,options);
      signLayout.local_to_image = calibration.worldToImage;
      signLayout.objects = signLayout.objects.map((object,index) => {
        object.object_to_world = object.object_to_composition;
        object.world_bounds_cm = object.bounds_cm;
        object.local_to_image = multiply(calibration.worldToImage,object.object_to_world);
        try {
          object.polygon_px = safePolygon(object.local_to_image,object.local_bounds_cm);
          if(isFacadeProjection(object.local_to_image))object.boundary_px=projectedBoundary(object.local_to_image,object.local_bounds_cm);
          quad(object.polygon_px);
          if (object.lines) object.lines.forEach(line => {
            line.world_bounds_cm = line.composition_bounds_cm;
            line.polygon_px = safePolygon(object.local_to_image,line.bounds_cm);
          });
        } catch (error) {
          if (options.preview !== true || object.type !== 'text') throw error;
          signLayout.warnings.push(`Вывеска ${index+1} временно не показана: ${error.message}`);
          return null;
        }
        object.fits_target = calibration.target_world_cm ? object.bounds_cm.every(p=>inside(p,calibration.target_world_cm))&&(object.boundary_px||object.polygon_px).every(p=>p[0]>=0&&p[1]>=0&&p[0]<=width&&p[1]<=height) : object.polygon_px.every(p => inside(p,target));
        if (!object.fits_target) {
          const message = `Вывеска ${index+1} выходит за ${project.target_polygon_px ? 'область установки' : 'границы фотографии'}. Измените её положение, размер или поворот.`;
          if (options.preview !== true) fail(message);
          signLayout.warnings.push(message);
        }
        if (project.calibration.mode === 'rectangle' && object.polygon_px.some(p => !inside(p,project.calibration.image_points))) warnings.push('Вывеска использует продолжение той же плоскости за пределами эталона; чувствительность к ошибкам может возрасти.');
        return object;
      }).filter(object => object !== null);
      if (signLayout.warnings) warnings.push(...signLayout.warnings);
      positioned = independentSignsPlacement(signLayout.objects);
      if (positioned) {
        signLayout.width_cm = positioned.width_cm;
        signLayout.height_cm = positioned.height_cm;
      }
    } else if (project.placement) {
      within(project.placement.center_px);
      positioned = placement(calibration, project.placement);
      if (project.sign?.objects !== undefined) {
        signLayout = objectsLayout(project.sign,project.placement,undefined,options);
        if (signLayout.warnings) warnings.push(...signLayout.warnings);
        const localToImage = positioned.local_to_image||homography([[0,0],[signLayout.width_cm,0],[signLayout.width_cm,signLayout.height_cm],[0,signLayout.height_cm]], positioned.polygon_px);
        signLayout.local_to_image = localToImage;
        signLayout.objects.forEach(object => {
          object.polygon_px = safePolygon(localToImage,object.bounds_cm);
          if(isFacadeProjection(localToImage)){
            object.local_to_image=multiply(localToImage,object.object_to_composition);
            object.boundary_px=projectedBoundary(localToImage,object.bounds_cm);
          }
          if (object.lines) object.lines.forEach(line => { line.polygon_px = safePolygon(localToImage,line.composition_bounds_cm); });
        });
      } else if (project.sign && (textLines(project.sign.text).length || project.sign.logo) && !product?.artwork) {
        textSettings(project.sign, project.placement);
        if (project.sign.preview_line_metrics || (!textLines(project.sign.text).length && project.sign.logo)) {
          const inset = product ? (Products.renderer(product)==='neon' ? product.params.backing!=='none' ? product.params.backing_margin_mm/10 : 0 : (product.params.margin_mm||0)/10) : 0;
          signLayout = textLayout(project.sign, {...project.placement,width_cm:project.placement.width_cm-inset*2,height_cm:project.placement.height_cm-inset*2});
          if (inset) {
            signLayout.lines.forEach(line => { line.x_cm += inset; line.y_cm += inset; line.baseline_cm += inset; line.bounds_cm = line.bounds_cm.map(([x,y])=>[x+inset,y+inset]); });
            if (signLayout.logo) { signLayout.logo.x_cm += inset; signLayout.logo.y_cm += inset; signLayout.logo.bounds_cm=signLayout.logo.bounds_cm.map(([x,y])=>[x+inset,y+inset]); }
            signLayout.width_cm=project.placement.width_cm; signLayout.height_cm=project.placement.height_cm;
          }
          const localToImage = positioned.local_to_image||homography([[0,0],[signLayout.width_cm,0],[signLayout.width_cm,signLayout.height_cm],[0,signLayout.height_cm]], positioned.polygon_px);
          signLayout.local_to_image = localToImage;
          signLayout.lines.forEach(line => { line.polygon_px = safePolygon(localToImage, line.bounds_cm); });
          if (signLayout.logo) signLayout.logo.polygon_px = safePolygon(localToImage, signLayout.logo.bounds_cm);
        } else warnings.push('Метрики шрифта не сохранены: габарит композиции рассчитан, границы отдельных строк не измерены. Откройте проект в редакторе для предпросмотра текста.');
      }
      if (positioned.polygon_px.some(p => p[0]<0||p[1]<0||p[0]>width||p[1]>height)) warnings.push('Макет выходит за границы фотографии.');
      if (project.calibration.mode === 'rectangle' && positioned.polygon_px.some(p => !inside(p, project.calibration.image_points))) warnings.push('Макет выходит за область эталона: используется продолжение той же плоскости, чувствительность к ошибкам может возрасти.');
      if (project.target_polygon_px) {
        quad(project.target_polygon_px).forEach(within);
        positioned.fits_target = calibration.target_world_cm?positioned.corners_cm.every(p=>inside(p,calibration.target_world_cm)):positioned.polygon_px.every(p => inside(p, project.target_polygon_px));
        if (!positioned.fits_target) warnings.push('Заданные габариты не помещаются в отмеченную область. Масштаб автоматически не изменён.');
      }
    }
    const measurements = (project.measurements || []).map(m => {
      if (m.same_plane !== true) return {name:m.name, length_cm:null, reason:'Принадлежность к плоскости эталона не подтверждена.'};
      m.image_points.forEach(within);
      if (project.calibration.mode === 'rectangle' && m.image_points.some(p => !inside(p, project.calibration.image_points))) warnings.push(`Замер «${m.name || ''}» использует продолжение плоскости за пределы эталона.`);
      return {name:m.name, image_points:m.image_points, length_cm:measure(calibration,m.image_points)};
    });
    let ruler = null;
    if (project.ruler !== undefined && project.ruler !== null) {
      const points = rulerPoints(project.ruler.image_points);
      points.forEach(within);
      const samePlane = project.ruler.same_plane === true;
      ruler = {image_points:points.map(p => [...p]), same_plane:samePlane,
        segment_lengths_cm:null, total_cm:null, cumulative_lengths_cm:null, points_cm:null};
      if (samePlane) {
        try { Object.assign(ruler, measurePolyline(calibration, points)); }
        catch (error) {
          // An exploratory ruler cannot invalidate an otherwise usable sign.
          ruler.error = error.message;
          warnings.push(`Линейка: ${error.message}`);
        }
      } else ruler.reason = 'Принадлежность к плоскости эталона не подтверждена.';
      if (samePlane && project.calibration.mode === 'rectangle' && points.some(p => !inside(p, project.calibration.image_points))) warnings.push('Линейка использует продолжение плоскости за пределы эталона.');
    }
    const checks = (project.checks || []).map(ch => {
      if (ch.same_plane !== true) fail('Контрольный размер должен принадлежать той же плоскости.');
      ch.image_points.forEach(within);
      const actual = measure(calibration,ch.image_points), expected = positive(ch.length_cm, 'Контрольный размер');
      const residual = (actual-expected)/expected*100;
      if (Math.abs(residual) > (project.check_tolerance_pct ?? 5)) warnings.push(`Контроль «${ch.name || ''}»: расхождение ${residual.toFixed(1)}%. Проверьте точки, размеры и плоскость.`);
      return {name:ch.name, expected_cm:expected, measured_cm:actual, residual_pct:residual};
    });
    if (!checks.length) warnings.push('Нет независимого контрольного размера; погрешность в сантиметрах не установлена.');
    return {version:original.version, image:project.image, calibration, placement:positioned, sign_layout:signLayout, measurements, ruler, checks, warnings:[...new Set(warnings)],
      ...(options.preview === true ? {preview:true} : {}),
      ...(Products ? {product:Products.summary(original),capabilities:Products.capabilities(original)} : {}),
      accuracy:product && product.type !== 'channel_letters' ? 'Не является обмером для производства. Толщина изделия и форма неона задаются по ТЗ.' : 'Не является обмером для производства. Глубина букв не восстанавливается из плоской калибровки.'};
  }
  const escapeXml = v => String(v).replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[x]));
  function compositionFontFamily(family) {
    // A user entry is exactly one family name, including any commas. Use the
    // same CSS string in Canvas measurement and SVG, then escape it for XML.
    // CSS hex escapes also keep quotes, backslashes and control characters
    // inside the quoted family rather than changing the fallback list.
    const quoted = String(family).replace(/["\\\u0000-\u001f\u007f]/g, character => `\\${character.codePointAt(0).toString(16)} `);
    return `"${quoted}", Arial, sans-serif`;
  }
  function localCompositionSvg(layout, color) {
    if (!layout) return '';
    if (Array.isArray(layout.objects)) return layout.objects.map((object,index) => {
      const transform = `translate(${object.x_cm} ${object.y_cm}) rotate(${object.rotation_deg} ${object.width_cm/2} ${object.height_cm/2})`;
      const logoId = layout.svg_id_prefix ? `${layout.svg_id_prefix}-logo-${index}` : `signage-preview-logo-object-${index}`;
      const art = object.type === 'logo' ? `<image id="${escapeXml(logoId)}" data-composition-logo="true" width="${object.width_cm}" height="${object.height_cm}" preserveAspectRatio="xMidYMid meet" href="${escapeXml(object.data_url)}"/>` :
        `<text font-family="${escapeXml(compositionFontFamily(object.font_family))}" font-weight="${object.font_weight}" font-size="${object.font_size_cm}" fill="${escapeXml(object.front_color || color || '#fff3dc')}" xml:space="preserve">${object.lines.filter(line => !line.blank).map(line => `<tspan x="${line.x_cm}" y="${line.baseline_cm}">${escapeXml(line.text)}</tspan>`).join('')}</text>`;
      return `<g data-object-id="${escapeXml(object.id)}" data-object-type="${object.type}" transform="${transform}">${art}</g>`;
    }).join('');
    const modern = layout.logo || layout.lines.some(line => line.font_size_cm !== undefined);
    const family = modern ? compositionFontFamily(layout.font_family) : `${layout.font_family},sans-serif`;
    const text = `<text font-family="${escapeXml(family)}" font-weight="${escapeXml(layout.font_weight)}" font-size="${layout.font_size_cm}" fill="${escapeXml(color || '#fff3dc')}" xml:space="preserve">${layout.lines.filter(line => !line.blank).map(line => `<tspan x="${line.x_cm}" y="${line.baseline_cm}"${line.font_size_cm === undefined ? '' : ` font-size="${line.font_size_cm}" font-family="${escapeXml(compositionFontFamily(line.font_family))}" font-weight="${escapeXml(line.font_weight)}"`}>${escapeXml(line.text)}</tspan>`).join('')}</text>`;
    const logo = layout.logo;
    return text+(logo ? `<image id="signage-preview-logo" data-composition-logo="true" x="${logo.x_cm}" y="${logo.y_cm}" width="${logo.width_cm}" height="${logo.height_cm}" preserveAspectRatio="xMidYMid meet" href="${escapeXml(logo.data_url)}"/>` : '');
  }
  function projectedTextSvg(layout, color) {
    if (!layout) return '';
    if (layout.independent_signs) return layout.objects.map((object,index) => {
      const prefix = `signage-independent-${index}`;
      const localObject = {...object,x_cm:0,y_cm:0,rotation_deg:0};
      const local = {width_cm:object.width_cm,height_cm:object.height_cm,local_to_image:object.local_to_image,
        objects:[localObject],svg_id_prefix:prefix};
      return projectedArtSvg(local,localCompositionSvg(local,color),`${prefix}-preview`,`${prefix}-art`,`${prefix}-clip`);
    }).join('');
    return projectedArtSvg(layout,localCompositionSvg(layout,color),'signage-preview-text','signage-preview-art','signage-text-clip');
  }
  function projectedArtSvg(layout, art, groupId, artId, clipPrefix) {
    const h = layout.local_to_image;
    // SVG has no projective matrix for native text. A small adaptive triangle
    // mesh approximates the same homography, subdividing at .2 px midpoint
    // error up to six levels. This remains a technical font preview, not CAD.
    // The photograph and geometry guides themselves are never transformed.
    const patches = [], clips = [];
    const triangle = (source, target) => {
      const sx = source.map(([x,y]) => [x,y,1]);
      const ax = solve(sx, target.map(p => p[0])), ay = solve(sx, target.map(p => p[1]));
      const id = `${clipPrefix}-${clips.length}`;
      clips.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><polygon points="${target.map(p => p.join(',')).join(' ')}"/></clipPath>`);
      patches.push(`<g clip-path="url(#${id})"><use href="#${artId}" transform="matrix(${ax[0]} ${ay[0]} ${ax[1]} ${ay[1]} ${ax[2]} ${ay[2]})"/></g>`);
    };
    const cell = (x, y, w, height, depth) => {
      const source = [[x,y],[x+w,y],[x+w,y+height],[x,y+height]];
      const target = source.map(p => apply(h,p));
      const samples = [[0,1],[1,2],[2,3],[3,0],[0,2]];
      const error = Math.max(...samples.map(([a,b]) => distance(apply(h,[(source[a][0]+source[b][0])/2,(source[a][1]+source[b][1])/2]),[(target[a][0]+target[b][0])/2,(target[a][1]+target[b][1])/2])));
      if (error > .2 && depth < 6) {
        cell(x,y,w/2,height/2,depth+1); cell(x+w/2,y,w/2,height/2,depth+1);
        cell(x+w/2,y+height/2,w/2,height/2,depth+1); cell(x,y+height/2,w/2,height/2,depth+1);
      } else {
        triangle([source[0],source[1],source[2]],[target[0],target[1],target[2]]);
        triangle([source[0],source[2],source[3]],[target[0],target[2],target[3]]);
      }
    };
    if (!isFacadeProjection(h)&&Math.abs(h[6]) + Math.abs(h[7]) < 1e-12) {
      return `<g id="${groupId}" transform="matrix(${h[0]} ${h[3]} ${h[1]} ${h[4]} ${h[2]} ${h[5]})">${art}</g>`;
    }
    cell(0, 0, layout.width_cm, layout.height_cm, 0);
    return `<g id="${groupId}"><defs><g id="${artId}">${art}</g>${clips.join('')}</defs>${patches.join('')}</g>`;
  }
  function productPreviewSvg(project, report = analyze(project), options = {}) {
    if (!report.placement || options.includeText === false) return '';
    if (project.version === 1) return projectedTextSvg(report.sign_layout,project.sign?.front_color);
    if (!Products) fail('Не загружен модуль изделий.');
    const product = Products.validateProduct(Products.activeProduct(project)), params = product.params, family=Products.renderer(product);
    if (report.sign_layout?.independent_signs) return projectedTextSvg(report.sign_layout,params.front_color);
    const width = product.placement.width_cm, height = product.placement.height_cm;
    const layout = {width_cm:width,height_cm:height,
      local_to_image:report.placement.local_to_image||homography([[0,0],[width,0],[width,height],[0,height]],report.placement.polygon_px)};
    const parts = [];
    if (family === 'plaque') {
      parts.push(`<rect width="${width}" height="${height}" rx="${params.corner_radius_mm/10}" fill="${escapeXml(params.background_color)}"/>`);
      if (params.mounting === 'standoffs' || params.mounting === 'screws') {
        [[1.25,1.25],[width-1.25,1.25],[width-1.25,height-1.25],[1.25,height-1.25]].forEach(([x,y])=>parts.push(`<circle cx="${x}" cy="${y}" r=".5" fill="#aaaaaa" stroke="#555555" stroke-width=".08"/>`));
      }
    } else if (family === 'lightbox') {
      if(params.illumination==='on')parts.push(`<defs><filter id="signage-lightbox-glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${params.glow_mm/10*1.8}"/></filter></defs><rect width="${width}" height="${height}" fill="${escapeXml(params.background_color)}" filter="url(#signage-lightbox-glow)" opacity=".5"/>`);
      parts.push(`<rect width="${width}" height="${height}" fill="${escapeXml(params.background_color)}" stroke="#667078" stroke-width=".2"/>`);
    } else if (family === 'neon' && params.backing !== 'none') {
      parts.push(`<rect width="${width}" height="${height}" rx=".5" fill="${params.backing==='black'?'#101014':'#dceef3'}" fill-opacity="${params.backing==='black'?'.96':'.13'}" stroke="#b9c5cc" stroke-opacity=".35" stroke-width=".08"/>`);
    }
    if (product.artwork) {
      // The original raster is never re-typeset. Its aspect ratio stays intact
      // inside the product envelope; a saved design remains a saved design.
      const inset = family === 'neon' ? params.backing !== 'none' ? params.backing_margin_mm/10 : 0 : (params.margin_mm||0)/10;
      const innerWidth = positive(width-2*inset,'Полезная ширина оригинала'), innerHeight = positive(height-2*inset,'Полезная высота оригинала');
      const scale = Math.min(innerWidth/product.artwork.width_px,innerHeight/product.artwork.height_px);
      const artworkWidth=product.artwork.width_px*scale, artworkHeight=product.artwork.height_px*scale;
      const glow = family === 'neon' && params.illumination === 'on';
      if (glow) {
        // Like the compositor, blur premultiplied source colour and alpha.
        // An uploaded multicolour contour keeps its own halo hues.
        const alphaTable=Array.from({length:256},(_,value)=>(Math.min(160,Math.round(value*1.6))/255).toFixed(6)).join(' ');
        parts.push(`<defs><filter id="signage-neon-artwork-glow" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceGraphic" stdDeviation="${params.tubing_mm/10*1.8}" result="halo"/><feComponentTransfer><feFuncA type="table" tableValues="${alphaTable}"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`);
      }
      parts.push(`<image id="signage-exact-artwork" x="${(width-artworkWidth)/2}" y="${(height-artworkHeight)/2}" width="${artworkWidth}" height="${artworkHeight}" preserveAspectRatio="xMidYMid meet" ${glow?'filter="url(#signage-neon-artwork-glow)" ':''}${['flat_print','cutout'].includes(family)?`opacity="${params.opacity}" `:''}href="${escapeXml(product.artwork.data_url)}"/>`);
    }
    const background = parts.length ? projectedArtSvg(layout,parts.join(''),'signage-preview-product','signage-product-art','signage-product-clip') : '';
    let text = product.artwork ? '' : projectedTextSvg(report.sign_layout,params.front_color);
    if (family === 'neon' && text && params.illumination === 'on') {
      const h=layout.local_to_image;
      let scale;
      if(isFacadeProjection(h)){
        const p=[width/2,height/2],origin=apply(h,p),x=apply(h,[p[0]+.01,p[1]]),y=apply(h,[p[0],p[1]+.01]);
        scale=Math.sqrt(Math.abs((x[0]-origin[0])*(y[1]-origin[1])-(x[1]-origin[1])*(y[0]-origin[0])))/.01;
      }else scale=Math.sqrt(Math.abs(h[0]*h[4]-h[1]*h[3]));
      text=`<defs><filter id="signage-neon-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${Math.max(1,scale)*params.tubing_mm/20}"/></filter></defs><g filter="url(#signage-neon-glow)" opacity=".5">${text.replace(/id="/g,'data-preview-id="')}</g>${text}`;
    }
    return background+text;
  }
  function rulerSvg(ruler, w, h, sw, size, occupied) {
    const points = ruler?.image_points;
    if (!points?.length) return '';
    const font = size * .85, gap = size * 1.5, radius = size * .68;
    const overlaps = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    occupied = [...occupied, ...points.map(([x,y]) => ({x:x-radius, y:y-radius, w:radius*2, h:radius*2}))];
    const label = (text, candidates, kind) => {
      const width = Math.min(w - 6, text.length * font * .62 + 14), height = font * 1.6;
      const boxes = candidates.map(([x,y]) => ({x:Math.max(3, Math.min(w-width-3, x-width/2)), y:Math.max(3, Math.min(h-height-3, y-height/2)), w:width, h:height}));
      // Prefer a clear side of a segment, without shifting the measured points.
      // Crowded chains may still overlap; the geometry always stays unchanged.
      const box = boxes.reduce((best, next) => occupied.reduce((n, b) => n + overlaps(next,b), 0) < occupied.reduce((n, b) => n + overlaps(best,b), 0) ? next : best);
      occupied.push(box);
      return `<g class="ruler-${kind}"><rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="4" fill="#102b46" fill-opacity=".94"/><text x="${box.x+box.w/2}" y="${box.y+box.h/2+font*.35}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${font}" fill="white">${escapeXml(text)}</text></g>`;
    };
    const labels = [];
    if (ruler.same_plane && ruler.segment_lengths_cm) {
      for (let i = 1; i < points.length; i++) {
        const a = points[i-1], b = points[i], length = distance(a,b), mid = [(a[0]+b[0])/2, (a[1]+b[1])/2];
        const normal = length ? [-(b[1]-a[1])/length, (b[0]-a[0])/length] : [0,-1];
        labels.push(label(`≈ ${ruler.segment_lengths_cm[i-1].toFixed(1)} см`, [1,-1,2,-2].map(k => [mid[0]+normal[0]*gap*k, mid[1]+normal[1]*gap*k]), 'segment-label'));
      }
    }
    const end = points[points.length-1];
    labels.push(label(ruler.same_plane && ruler.total_cm !== null ? `Всего ≈ ${ruler.total_cm.toFixed(1)} см` : ruler.error ? 'Размер не рассчитан' : 'Плоскость не подтверждена',
      [[end[0]+gap*3,end[1]+gap], [end[0]-gap*3,end[1]+gap], [end[0]+gap*3,end[1]-gap], [end[0]-gap*3,end[1]-gap]], 'total-label'));
    return `<g id="signage-ruler"><polyline points="${points.map(p => p.map(v => v.toFixed(3)).join(',')).join(' ')}" fill="none" stroke="#2563eb" stroke-width="${sw*2}" stroke-linejoin="round" stroke-linecap="round"/>${points.map(([x,y],i) => `<g class="ruler-point"><circle cx="${x}" cy="${y}" r="${radius}" fill="#2563eb" stroke="white" stroke-width="${sw}"/><text x="${x}" y="${y+size*.23}" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700" font-size="${size*.65}" fill="white">${i+1}</text></g>`).join('')}${labels.join('')}</g>`;
  }
  function overlaySvg(project, report = analyze(project), imageHref = '', options = {}) {
    const preview = productPreviewSvg(project,report,options);
    if (project.version === 2) project = Products.legacyProject(project);
    const w = project.image.width_px, h = project.image.height_px, sw = Math.max(1.5, w/650), size = Math.max(14,w/65);
    const poly = points => points.map(p=>p.map(v=>v.toFixed(3)).join(',')).join(' ');
    const independent = report.sign_layout?.independent_signs === true;
    const p = independent ? null : report.placement?.boundary_px||report.placement?.polygon_px;
    const sceneLabels = project.sign?.objects !== undefined ? report.sign_layout?.objects?.filter(object => object.type === 'text').flatMap(object => textLines(object.text)) || [] : textLines(project.sign?.text);
    const labels = independent ? [`Независимые вывески: ${report.sign_layout.objects.length}`] : p ? [...(sceneLabels.length ? sceneLabels : ['Макет']), `${Number(project.placement.width_cm.toFixed(1))} × ${Number(project.placement.height_cm.toFixed(1))} см (вся композиция)`] : ['Калибровка'];
    const label = labels.join('\n');
    const reference = options.includeReference === false ? [] : project.calibration.image_points;
    const occupiedLabels = [{x:10, y:10, w:Math.min(w-20, Math.max(...labels.map(line => line.length))*size*.6+28), h:size*(labels.length*1.25+.8)},
      ...report.measurements.filter(m => m.length_cm !== null).map(m => ({x:m.image_points[0][0], y:m.image_points[0][1]-size*1.5, w:(`≈ ${m.length_cm.toFixed(1)} см`).length*size*.65, h:size*1.4}))];
    const signFrames = independent ? report.sign_layout.objects.map(object => `<polygon data-sign-outline="${escapeXml(object.id)}" points="${poly(object.boundary_px||object.polygon_px)}" fill="none" stroke="${object.fits_target ? '#ffb454' : '#f87171'}"/>`).join('') : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><title>${escapeXml(label)}</title>${imageHref ? `<image width="${w}" height="${h}" href="${escapeXml(imageHref)}"/>` : ''}${preview}<g stroke-linejoin="round" stroke-width="${sw}">${project.target_polygon_px ? `<polygon points="${poly(report.calibration.target_boundary_px||project.target_polygon_px)}" fill="#26a57b" fill-opacity=".08" stroke="#36d399" stroke-dasharray="8 5"/>` : ''}<polyline points="${poly([...reference,...(reference.length===4?[reference[0]]:[])])}" stroke="#2dd4bf" fill="none"/>${reference.map((v,i)=>`<circle cx="${v[0]}" cy="${v[1]}" r="${sw*2.6}" fill="#2dd4bf"/><text x="${v[0]+size/2}" y="${v[1]-size/2}" font-family="Arial,sans-serif" font-size="${size}" stroke="#102129" stroke-width="${sw}" paint-order="stroke" fill="white">${i+1}</text>`).join('')}${p?`<polygon points="${poly(p)}" fill="#ffb454" fill-opacity=".16" stroke="#ffb454"/>`:''}${signFrames}${report.measurements.filter(m=>m.length_cm!==null).map(m=>`<polyline points="${poly(m.image_points)}" fill="none" stroke="#a78bfa"/><text x="${m.image_points[0][0]}" y="${m.image_points[0][1]-size/2}" font-family="Arial,sans-serif" font-size="${size}" stroke="#18212f" stroke-width="${sw}" paint-order="stroke" fill="white">≈ ${m.length_cm.toFixed(1)} см</text>`).join('')}</g><rect x="10" y="10" width="${Math.min(w-20, Math.max(...labels.map(line => line.length))*size*.6+28)}" height="${size*(labels.length*1.25+.8)}" rx="7" fill="#11202e" fill-opacity=".93"/><text font-size="${size}" font-family="Arial,sans-serif" fill="#fff">${labels.map((line,i) => `<tspan x="22" y="${size*(1.7+i*1.25)}">${escapeXml(line)}</tspan>`).join('')}</text>${options.includeRuler === false ? '' : rulerSvg(report.ruler, w, h, sw, size, occupiedLabels)}</svg>`;
  }
  return {apply, inverse, homography, calibrate, sceneCalibration, multiply, projectedBoundary, isFacadeProjection, measure, measurePolyline, placement, analyze, inside, quad, overlaySvg, productPreviewSvg, localCompositionSvg, compositionFontFamily, distance, textLayout, textLines,letterHeightReference,independentObjectLayout,objectsLayout,independentSignsFromComposition};
});
