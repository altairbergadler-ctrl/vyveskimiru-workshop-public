/* Shared browser/Node lens model. Coordinates belong to the original photograph.
 * A known metric rectangle supplies perspective; optional points on its four
 * straight edges estimate one centered division-model lens coefficient.
 * This module transforms coordinates, never image pixels.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SignageFacadeProjection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const fail = message => { throw new Error(message); };
  const point = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) ? value : fail('Нужна конечная точка [x, y].');
  const positive = (value, name) => Number.isFinite(value) && value > 0 ? value : fail(`${name}: требуется число больше нуля.`);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const meanSquare = values => values.reduce((sum, value) => sum + value * value, 0) / Math.max(1, values.length);

  function imageSpec(image) {
    const width = positive(image?.width ?? image?.width_px, 'Ширина фото');
    const height = positive(image?.height ?? image?.height_px, 'Высота фото');
    const scale = Math.max(width, height), center = [width / 2, height / 2];
    const fieldRadiusSquared = ((width / 2) ** 2 + (height / 2) ** 2) / scale ** 2;
    // Across the whole photo both 1+k*r^2 and 1-k*r^2 stay >= .2.
    // This excludes poles and folds, including the poorly conditioned margin.
    const limit = .8 / fieldRadiusSquared;
    return {width, height, scale, center, fieldRadiusSquared, safeInterval: [-limit, limit]};
  }

  function createLens({image, k = 0}) {
    const spec = imageSpec(image), {center, scale, safeInterval} = spec;
    if (!Number.isFinite(k) || k < safeInterval[0] || k > safeInterval[1]) fail('Коррекция объектива слишком сильная: возможны разрывы или перегиб изображения.');
    const undistort = input => {
      const p = point(input), x = p[0] - center[0], y = p[1] - center[1];
      const radial = k * (x * x + y * y) / scale ** 2, denominator = 1 + radial;
      if (denominator <= 1e-8 || 1 - radial <= 1e-8) fail('Точка достигает разрыва или перегиба модели объектива.');
      return [center[0] + x / denominator, center[1] + y / denominator];
    };
    const distort = input => {
      const p = point(input), x = p[0] - center[0], y = p[1] - center[1];
      const radiusSquared = (x * x + y * y) / scale ** 2;
      if (radiusSquared === 0 || k === 0) return [...p];
      const discriminant = 1 - 4 * k * radiusSquared;
      if (discriminant <= 1e-12) fail('Точка достигает перегиба модели объектива.');
      // Stable quadratic root continuously connected to k=0. The other root
      // is beyond the radial fold and is never a valid inverse here.
      const factor = 2 / (1 + Math.sqrt(discriminant));
      const result = [center[0] + x * factor, center[1] + y * factor];
      undistort(result); // Also reject poles for extrapolated coordinates.
      return result;
    };
    return {...spec, k, undistort, distort};
  }

  function lineResidual(lens, a, b, sample) {
    const u = lens.undistort(a), v = lens.undistort(b), p = lens.undistort(sample);
    const dx = v[0] - u[0], dy = v[1] - u[1], length = Math.hypot(dx, dy);
    if (length < 1e-7) fail('Направляющая слишком короткая.');
    const normal = [-dy / length, dx / length];
    const residual = (p[0] - u[0]) * normal[0] + (p[1] - u[1]) * normal[1];
    // Convert the straight-line residual back to local original-photo pixels
    // with the normal component of the undistortion Jacobian. This prevents
    // fits winning simply because their undistorted coordinate space shrank.
    const x = sample[0] - lens.center[0], y = sample[1] - lens.center[1];
    const f = 1 + lens.k * (x * x + y * y) / lens.scale ** 2;
    const common = 2 * lens.k * (x * normal[0] + y * normal[1]) / (lens.scale ** 2 * f * f);
    const gradient = Math.hypot(normal[0] / f - x * common, normal[1] / f - y * common);
    const t = ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / (length * length);
    return {residual: residual / gradient, normal, t};
  }

  function goldenMinimum(fn, low, high, iterations = 48) {
    const ratio = (Math.sqrt(5) - 1) / 2;
    let a = low, b = high, x = b - ratio * (b - a), y = a + ratio * (b - a), fx = fn(x), fy = fn(y);
    for (let i = 0; i < iterations; i++) {
      if (fx <= fy) { b = y; y = x; fy = fx; x = b - ratio * (b - a); fx = fn(x); }
      else { a = x; x = y; fx = fy; y = a + ratio * (b - a); fy = fn(y); }
    }
    return fx <= fy ? {value: x, score: fx} : {value: y, score: fy};
  }

  function fitLens(image, corners, midpoints, enabled) {
    const base = createLens({image, k: 0}), warnings = [];
    const guides = midpoints.map((sample, index) => sample ? {a: corners[index], b: corners[(index + 1) % 4], sample, index} : null).filter(Boolean);
    let usedGuides = guides;
    const residuals = k => {
      const lens = createLens({image, k});
      return usedGuides.map(guide => lineResidual(lens, guide.a, guide.b, guide.sample).residual);
    };
    let baselineResidualPx = Math.sqrt(meanSquare(residuals(0)));
    if (!enabled) return {lens: base, warnings, fit: {status: 'disabled', samples: guides.length, baselineResidualPx, residualPx: baselineResidualPx, applied: false}};
    if (guides.length < 2) {
      warnings.push('Для оценки объектива нужны дополнительные точки хотя бы на двух разных границах зоны. Пока учтена только перспектива.');
      return {lens: base, warnings, fit: {status: 'unsupported', samples: guides.length, baselineResidualPx, residualPx: baselineResidualPx, applied: false}};
    }
    const step = .001;
    const details = guides.map(guide => {
      const before = lineResidual(createLens({image, k: -step}), guide.a, guide.b, guide.sample);
      const after = lineResidual(createLens({image, k: step}), guide.a, guide.b, guide.sample);
      return {...guide, normal: before.normal, t: before.t, sensitivity: (after.residual - before.residual) / (2 * step)};
    });
    const span = base.safeInterval[1] - base.safeInterval[0];
    const informative = details.filter(item => item.t > .08 && item.t < .92 && Math.abs(item.sensitivity) * span > 3);
    const independent = informative.some((a, i) => informative.slice(i + 1).some(b => Math.abs(a.normal[0] * b.normal[1] - a.normal[1] * b.normal[0]) > .15));
    const information = Math.sqrt(informative.reduce((sum, item) => sum + item.sensitivity ** 2, 0));
    if (informative.length < 2 || !independent || information < 1e-5) {
      warnings.push('По этим точкам искажение объектива определяется ненадёжно. Выберите длинные границы разных направлений, дальше от центра фото; дополнительные точки ставьте между углами. Пока учтена только перспектива.');
      return {lens: base, warnings, fit: {status: 'unsupported', samples: guides.length, baselineResidualPx, residualPx: baselineResidualPx, applied: false}};
    }
    usedGuides = informative;
    baselineResidualPx = Math.sqrt(meanSquare(residuals(0)));
    if (informative.length < guides.length) warnings.push('Некоторые дополнительные точки не использованы: ставьте их в средней части соответствующей границы. Короткие и радиальные направляющие не определяют искажение объектива.');
    const objective = k => {
      try { return meanSquare(residuals(k)); } catch { return Infinity; }
    };
    const count = 160, [low, high] = base.safeInterval, grid = [];
    for (let i = 0; i <= count; i++) { const k = low + (high - low) * i / count; grid.push({k, score: objective(k)}); }
    let bestIndex = 0;
    for (let i = 1; i < grid.length; i++) if (grid[i].score < grid[bestIndex].score) bestIndex = i;
    const refined = goldenMinimum(objective, grid[Math.max(0, bestIndex - 1)].k, grid[Math.min(count, bestIndex + 1)].k);
    const best = refined.score < grid[bestIndex].score ? {k: refined.value, score: refined.score} : grid[bestIndex];
    const residualPx = Math.sqrt(best.score);
    if (!Number.isFinite(residualPx)) fail('По этим направляющим не удалось построить устойчивую модель объектива.');
    const limited = best.k - low < span * .005 || high - best.k < span * .005;
    const inconsistent = residualPx > 3;
    if (limited) warnings.push('Оценка достигла безопасной границы модели. Уточните точки; этот объектив может требовать другой модели.');
    if (inconsistent) warnings.push('Границы не согласуются с одной моделью объектива: остаточное расхождение больше 3 пикселей. Уточните точки или плоскость.');
    warnings.push('Это приближение по отмеченным границам с предполагаемым центром объектива в центре фото. Точность не является поверенным замером.');
    return {lens: createLens({image, k: best.k}), warnings, fit: {status: inconsistent ? 'inconsistent' : limited ? 'bounded' : 'fitted', samples: guides.length, usedSamples: informative.length, usedEdges: informative.map(guide => guide.index), applied: true,
      baselineResidualPx, residualPx, pickingSensitivityK: .5 / information, residualsPx: residuals(best.k)}};
  }

  return {createLens, fitLens};
});
