/* Live measurement overlay. Image coordinates are retained; labels use CSS pixels. */
(function () {
  'use strict';
  const G = window.LetterGeometry;
  const svgNode = (tag, attrs = {}) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  };
  const cm = value => `≈ ${value.toLocaleString('ru-RU', {maximumFractionDigits: 1})} см`;
  function validate(points, image) {
    if (!Array.isArray(points) || points.length > 256) throw new Error('Линейка: допустимо не более 256 точек.');
    return points.map(point => {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite) ||
          point[0] < 0 || point[1] < 0 || point[0] > image.width_px || point[1] > image.height_px) {
        throw new Error('Линейка: точка должна находиться внутри исходного фото.');
      }
      return [...point];
    });
  }
  function draw(svg, {image, points, hover, calibration, calibrationError, samePlane, active, width, height}) {
    svg.replaceChildren();
    if (!image || !width || !height || (!active && !points.length)) return {measurement: null, error: ''};
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const local = point => [point[0] * width / image.width_px, point[1] * height / image.height_px];
    const placed = points.map(local);
    let measurement = null;
    let error = !samePlane ? 'Подтвердите, что точки лежат в плоскости эталона.' : !calibration ? calibrationError || 'Задайте эталон для размеров в сантиметрах.' : '';
    if (!error) {
      try { measurement = G.measurePolyline(calibration, points); }
      catch (problem) { error = problem.message; }
    }
    const label = (text, x, y, {dark = false, preview = false} = {}) => {
      const boxWidth = Math.min(width - 8, Math.max(36, text.length * 7 + 16)), boxHeight = 24;
      x = Math.max(4 + boxWidth / 2, Math.min(width - 4 - boxWidth / 2, x));
      y = Math.max(4, Math.min(height - boxHeight - 4, y));
      const group = svgNode('g', {'class': preview ? 'ruler-preview-label' : 'ruler-label'});
      group.append(svgNode('rect', {x: x - boxWidth / 2, y, width: boxWidth, height: boxHeight, rx: 6,
        fill: dark ? '#39255c' : '#ffffff', 'fill-opacity': '.96', stroke: '#7652ad', 'stroke-width': 1}));
      const textNode = svgNode('text', {x, y: y + 16, 'text-anchor': 'middle', fill: dark ? '#ffffff' : '#39255c',
        'font-family': 'Arial, sans-serif', 'font-size': 12, 'font-weight': 700});
      textNode.textContent = text;
      group.append(textNode);
      svg.append(group);
    };
    if (placed.length > 1) {
      const coordinates = placed.map(point => point.join(',')).join(' ');
      svg.append(svgNode('polyline', {points: coordinates, fill: 'none', stroke: '#ffffff', 'stroke-width': 5, 'stroke-linejoin': 'round'}));
      svg.append(svgNode('polyline', {points: coordinates, fill: 'none', stroke: '#7951ad', 'stroke-width': 3, 'stroke-linejoin': 'round'}));
      placed.slice(1).forEach((point, index) => {
        const previous = placed[index];
        label(measurement ? cm(measurement.segment_lengths_cm[index]) : '— см',
          (point[0] + previous[0]) / 2, (point[1] + previous[1]) / 2 - 29);
      });
    }
    if (active && hover && placed.length && points.length < 256) {
      const from = placed[placed.length - 1], to = local(hover);
      svg.append(svgNode('line', {x1: from[0], y1: from[1], x2: to[0], y2: to[1], stroke: '#7951ad', 'stroke-width': 2, 'stroke-dasharray': '6 5'}));
      if (measurement) {
        try {
          const next = G.measurePolyline(calibration, [points[points.length - 1], hover]);
          label(`+ ${cm(next.total_cm)}`, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2 + 10, {preview: true});
        } catch (_) { /* A pointer near the projection horizon has no valid preview distance. */ }
      }
    }
    placed.forEach((point, index) => {
      const group = svgNode('g', {'class': 'ruler-vertex', 'data-ruler-index': index});
      group.append(svgNode('circle', {cx: point[0], cy: point[1], r: 11, fill: '#ffffff', stroke: '#7951ad', 'stroke-width': 2.5}));
      const text = svgNode('text', {x: point[0], y: point[1] + 4, 'text-anchor': 'middle', fill: '#39255c',
        'font-family': 'Arial, sans-serif', 'font-size': 11, 'font-weight': 700});
      text.textContent = index + 1;
      group.append(text);
      svg.append(group);
    });
    const summary = measurement && points.length > 1 ? `Итого: ${cm(measurement.total_cm)}` :
      error ? 'Для размеров нужна калибровка' : points.length ? 'Добавьте следующую точку' : 'ЛКМ: добавить точку';
    label(!samePlane ? 'Укажите плоскость измерения' : summary, width / 2, 8, {dark: true});
    return {measurement, error};
  }
  window.SignageRuler = {validate, draw, formatCm: cm};
})();
