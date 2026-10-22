(function (root) {
  'use strict';

  const REFERENCE = '\u041d'; // Cyrillic capital Н, not Latin H.
  const MINIMUM_CM = 1.6;
  const FONT_PX = 480;
  const cache = new Map();
  const sampleFractions = [0.22, 0.27, 0.32, 0.37, 0.63, 0.68, 0.73, 0.78];
  const limitation = 'Ориентир по основным стойкам «Н». Тонкие перемычки, другие буквы и вся надпись требуют проверки в макете.';
  const reasons = {
    'invalid-input': 'Укажите шрифт, начертание и положительную высоту буквы.',
    'unsupported-browser': 'Браузер не поддерживает измерение шрифта.',
    'font-not-loaded': 'Нужное начертание шрифта ещё не загружено.',
    'empty-reference': 'Не удалось измерить контрольную букву «Н».',
    'unsupported-shape': 'У этого начертания нет устойчивых прямых стоек для такой оценки.',
    'slanted-stems': 'Наклонные или изогнутые стойки требуют ручной проверки.',
    'variable-stems': 'Ширина стоек заметно меняется; нужна проверка в макете.',
    'measurement-failed': 'Измерение недоступно; нужна проверка в макете.'
  };

  function unknown(reason) {
    return {
      status: 'unknown',
      ratio: null,
      reference: REFERENCE,
      confidence: 'unknown',
      method: 'canvas-reference-stems',
      estimatedStrokeCm: null,
      suggestedHeightCm: null,
      minimumStrokeCm: MINIMUM_CM,
      meetsMinimum: null,
      reason: reason,
      reasonText: reasons[reason] || reasons['measurement-failed'],
      limitation: limitation
    };
  }

  function median(values) {
    const sorted = values.slice().sort(function (a, b) { return a - b; });
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  // Kept independent from DOM to verify geometry with deterministic raster fixtures.
  function analyzeRaster(image) {
    const width = image.width;
    const height = image.height;
    const pixels = image.data;
    let left = width, right = -1, top = height, bottom = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (pixels[(y * width + x) * 4 + 3] >= 128) {
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
    }
    if (right < left || bottom < top) return unknown('empty-reference');
    const capHeightPx = bottom - top + 1;
    if (capHeightPx < 40) return unknown('empty-reference');

    const rows = [];
    sampleFractions.forEach(function (fraction) {
      const y = top + Math.round(fraction * (capHeightPx - 1));
      const runs = [];
      let start = null;
      for (let x = left; x <= right + 1; x++) {
        const ink = x <= right && pixels[(y * width + x) * 4 + 3] >= 128;
        if (ink && start === null) start = x;
        if (!ink && start !== null) {
          runs.push({ width: x - start, center: (start + x - 1) / 2 });
          start = null;
        }
      }
      // Ignore crossbar rows. Outline, stencil and decorative strokes often
      // produce extra runs; they must never become a fabricated measurement.
      if (runs.length === 2 && runs.every(function (run) { return run.width >= 2; })) {
        rows.push({ fraction: fraction, left: runs[0], right: runs[1] });
      }
    });
    const upper = rows.filter(function (row) { return row.fraction < 0.5; });
    const lower = rows.filter(function (row) { return row.fraction > 0.5; });
    if (rows.length < 6 || upper.length < 3 || lower.length < 3) return unknown('unsupported-shape');

    for (const side of ['left', 'right']) {
      const drift = Math.abs(
        median(upper.map(function (row) { return row[side].center; })) -
        median(lower.map(function (row) { return row[side].center; }))
      );
      if (drift > Math.max(3, capHeightPx * 0.04)) return unknown('slanted-stems');
      const widths = rows.map(function (row) { return row[side].width; });
      const typical = median(widths);
      if (Math.max.apply(null, widths) - Math.min.apply(null, widths) > Math.max(2, typical * 0.3)) {
        return unknown('variable-stems');
      }
    }

    // The thinner of the two measured main stems is the more conservative
    // reference. It still is not the thinnest part of a complete inscription.
    const stemWidthPx = Math.min(
      median(rows.map(function (row) { return row.left.width; })),
      median(rows.map(function (row) { return row.right.width; }))
    );
    const ratio = stemWidthPx / capHeightPx;
    if (ratio < 0.005 || ratio > 0.4) return unknown('unsupported-shape');
    return {
      status: 'measured',
      ratio: ratio,
      reference: REFERENCE,
      confidence: 'medium',
      method: 'canvas-reference-stems',
      capHeightPx: capHeightPx,
      stemWidthPx: stemWidthPx,
      sampledRows: rows.length
    };
  }

  function atHeight(measurement, heightCm) {
    if (measurement.status !== 'measured') return Object.assign({}, measurement);
    const estimated = measurement.ratio * heightCm;
    return Object.assign({}, measurement, {
      heightCm: heightCm,
      estimatedStrokeCm: Math.round(estimated * 100) / 100,
      // Round upwards to a practical 1 mm step, never down across the threshold.
      suggestedHeightCm: Math.ceil((MINIMUM_CM / measurement.ratio - 1e-10) * 10) / 10,
      minimumStrokeCm: MINIMUM_CM,
      meetsMinimum: estimated + 1e-10 >= MINIMUM_CM,
      limitation: limitation
    });
  }

  function normalizedFamily(value) {
    return String(value).trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  }

  async function measureReference(family, weight) {
    const quotedFamily = '"' + family.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    const font = weight + ' ' + FONT_PX + 'px ' + quotedFamily;
    try {
      const loaded = await root.document.fonts.load(font, REFERENCE);
      // A missing family otherwise silently uses a system fallback. Require a
      // real registered Face; the caller must also supply a Cyrillic-capable font.
      if (!loaded.some(function (face) {
        return normalizedFamily(face.family) === normalizedFamily(family) && face.status === 'loaded';
      })) return unknown('font-not-loaded');

      const canvas = root.document.createElement('canvas');
      let context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return unknown('unsupported-browser');
      context.font = font;
      const metrics = context.measureText(REFERENCE);
      const ascent = metrics.actualBoundingBoxAscent;
      const descent = metrics.actualBoundingBoxDescent;
      const bboxLeft = metrics.actualBoundingBoxLeft;
      const bboxRight = metrics.actualBoundingBoxRight;
      if (![ascent, descent, bboxLeft, bboxRight].every(Number.isFinite) || ascent + descent <= 0) {
        return unknown('empty-reference');
      }
      const padding = 8;
      canvas.width = Math.max(1, Math.ceil(bboxLeft + bboxRight) + padding * 2);
      canvas.height = Math.max(1, Math.ceil(ascent + descent) + padding * 2);
      context = canvas.getContext('2d', { willReadFrequently: true });
      context.font = font;
      context.fillStyle = '#000';
      context.textAlign = 'left';
      context.textBaseline = 'alphabetic';
      context.fillText(REFERENCE, padding + bboxLeft, padding + ascent);
      return analyzeRaster(context.getImageData(0, 0, canvas.width, canvas.height));
    } catch (_) {
      return unknown('measurement-failed');
    }
  }

  async function measure(fontFamily, weight, heightCm) {
    const family = typeof fontFamily === 'string' ? fontFamily.trim() : '';
    const fontWeight = weight === undefined || weight === null ? '700' : String(weight);
    const height = Number(heightCm);
    if (!family || /[\r\n\x00]/.test(family) || !/^(normal|bold|[1-9]\d{0,2}|1000)$/.test(fontWeight) || !Number.isFinite(height) || height <= 0) {
      return unknown('invalid-input');
    }
    if (!root || !root.document || !root.document.fonts || typeof root.document.fonts.load !== 'function') {
      return unknown('unsupported-browser');
    }
    const key = normalizedFamily(family) + '\u0000' + fontWeight;
    if (!cache.has(key)) cache.set(key, measureReference(family, fontWeight));
    const measurement = await cache.get(key);
    // Retry unavailable fonts on the next call once loading has completed.
    if (measurement.status === 'unknown') cache.delete(key);
    return atHeight(measurement, height);
  }

  const api = { measure: measure, clearCache: function () { cache.clear(); } };
  if (root) root.FontStroke = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { measure: measure, analyzeRaster: analyzeRaster, atHeight: atHeight };
  }
})(typeof window !== 'undefined' ? window : null);
