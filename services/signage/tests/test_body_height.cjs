'use strict';
const assert = require('node:assert/strict');
const G = require('../assets/geometry.js');
const P = require('../assets/products.js');
const copy = value => JSON.parse(JSON.stringify(value));
const close = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-7,
  `${message}: ${actual} != ${expected}`);
const metric = (text, ascent, descent = 0, width = 120, family = 'Arial', bold = true) => ({
  text, width, actualBoundingBoxLeft: text ? 3 : 0,
  actualBoundingBoxRight: text ? width - 3 : 0,
  actualBoundingBoxAscent: ascent, actualBoundingBoxDescent: descent,
  font_family: family, font_weight: bold ? 700 : 400,
});
const object = (text, rows, reference, changes = {}) => ({
  id: 'body', type: 'text', text, font_family: 'Arial', font_bold: true,
  letter_height_cm: 50, height_basis: 'body', height_reference: 'auto',
  line_gap_cm: 4, text_align: 'left', front_color: '#ABC123',
  x_cm: 20, y_cm: 20, rotation_deg: 0,
  preview_line_metrics: {font_size_px: 100, lines: rows, height_reference: reference},
  ...changes,
});

// Reference choice covers scripts and Unicode case categories, independent of
// which particular outlying glyph occurs. Explicit choices apply to mixed text.
for (const [text, selection, letterCase, reference] of [
  ['НО', 'auto', 'uppercase', 'Н'], ['но', 'auto', 'lowercase', 'н'],
  ['но\nЙ', 'auto', 'uppercase', 'Н'], ['Вывески', 'auto', 'uppercase', 'Н'],
  ['aя', 'auto', 'lowercase', 'н'], ['Aя', 'auto', 'uppercase', 'Н'],
  ['Ә', 'auto', 'uppercase', 'Н'], ['ә', 'auto', 'lowercase', 'н'],
  ['HÉ', 'auto', 'uppercase', 'H'], ['xgý', 'auto', 'lowercase', 'x'],
  ['ǅ', 'auto', 'uppercase', 'H'], ['123?!', 'auto', 'uppercase', 'H'],
  ['НОно', 'lowercase', 'lowercase', 'н'], ['но', 'uppercase', 'uppercase', 'Н'],
  ['Hxo', 'lowercase', 'lowercase', 'x'], ['xo', 'uppercase', 'uppercase', 'H'],
]) {
  assert.deepEqual(G.letterHeightReference({text, height_reference: selection}),
    {letter_case: letterCase, text: reference}, `${JSON.stringify(text)} / ${selection}`);
}
assert.deepEqual(G.letterHeightReference({text: 'но'}), {letter_case: 'lowercase', text: 'н'});

// The entire object uses the body's font scale. Accents, ascenders and
// descenders remain their real sizes, including glyphs beyond Й/Ц.
const groups = [
  {base: 'НО', reference: 'Н', body: 72, outliers: [
    ['Й', 95, 0], ['Ё', 90, 0], ['Ц', 72, 18], ['Щ', 72, 20],
    ['Д', 72, 15], ['Ф', 80, 8], ['Ӑ', 94, 0],
  ]},
  {base: 'но', reference: 'н', body: 50, outliers: [
    ['й', 70, 0], ['ё', 70, 0], ['ц', 50, 16], ['щ', 50, 18],
    ['д', 56, 16], ['ф', 75, 20], ['ӑ', 72, 0],
  ]},
  {base: 'HO', reference: 'H', body: 72, outliers: [
    ['Á', 94, 0], ['É', 93, 0], ['Ç', 72, 18], ['Ą', 72, 20],
  ]},
  {base: 'xo', reference: 'x', body: 50, outliers: [
    ['á', 73, 0], ['é', 72, 0], ['g', 50, 20], ['j', 73, 20],
    ['p', 50, 19], ['q', 50, 19], ['y', 50, 22], ['ǜ', 78, 0],
  ]},
];
let extendedUpper;
for (const {base, reference, body, outliers} of groups) {
  const bodyMetric = metric(reference, body, 0, 60);
  const plain = G.independentObjectLayout(object(base, [metric(base, body)], bodyMetric));
  close(plain.font_size_cm, 50 / (body / 100));
  close(plain.lines[0].height_cm, 50);
  for (const [glyph, ascent, descent] of outliers) {
    const text = base + glyph;
    const spec = object(text, [metric(text, ascent, descent, 180)], bodyMetric);
    const before = JSON.stringify(spec), layout = G.independentObjectLayout(spec);
    assert.equal(JSON.stringify(spec), before, 'Layout must not alter saved measurements or settings');
    close(layout.font_size_cm, plain.font_size_cm, `${glyph} must not resize neighbours`);
    close(layout.height_cm, (ascent + descent) / body * 50, `${glyph} full ink height`);
    close(layout.width_cm, 180 / body * 50, `${glyph} keeps the font's aspect ratio`);
    close(layout.lines[0].baseline_cm, ascent / body * 50, `${glyph} ink baseline`);
    assert.ok(layout.height_cm > 50, `${glyph} outlying ink must remain outside body height`);
    assert.deepEqual(layout.local_bounds_cm, [[0, 0], [layout.width_cm, 0],
      [layout.width_cm, layout.height_cm], [0, layout.height_cm]]);
    if (glyph === 'Й') extendedUpper = spec;
  }
}

// Body size is measured for the selected font and weight, rather than using
// an Arial coefficient or a percentage deduction for a list of glyphs.
for (const [family, bold, bodyHeight] of [
  ['Arial', true, 72], ['Arial', false, 70], ['Georgia', true, 79], ['Georgia', false, 75],
]) {
  const spec = object('НОЙ', [metric('НОЙ', bodyHeight + 23, 0, 210, family, bold)],
    metric('Н', bodyHeight, 0, 64, family, bold), {font_family: family, font_bold: bold});
  const layout = G.independentObjectLayout(spec);
  close(layout.font_size_cm, 50 / (bodyHeight / 100));
  close(layout.height_cm, (bodyHeight + 23) / bodyHeight * 50);
  assert.equal(layout.font_family, family); assert.equal(layout.font_weight, bold ? 700 : 400);
}

// Lowercase can define the body of mixed-case text explicitly. The capital and
// its accent remain proportionally larger; selecting capitals changes one scale.
const mixedText = 'НноЙ';
const lowerMixed = object(mixedText, [metric(mixedText, 95, 0, 240)], metric('н', 50, 0, 60),
  {height_reference: 'lowercase'});
const upperMixed = object(mixedText, [metric(mixedText, 95, 0, 240)], metric('Н', 72, 0, 64),
  {height_reference: 'uppercase'});
close(G.independentObjectLayout(lowerMixed).font_size_cm, 100);
close(G.independentObjectLayout(lowerMixed).height_cm, 95);
close(G.independentObjectLayout(upperMixed).font_size_cm, 50 / .72);
close(G.independentObjectLayout(upperMixed).height_cm, 95 / 72 * 50);

// All lines, including inner blank lines, use the same font scale. Real line
// ink bounds determine the block extent; the physical gap remains unchanged.
const multiline = object('\nНО\n\nцщ\n\n', [metric('НО', 72), metric('', 0, 0, 0), metric('цщ', 50, 18, 100)],
  metric('Н', 72, 0, 64));
const multi = G.independentObjectLayout(multiline);
assert.deepEqual(multi.lines.map(row => row.text), ['НО', '', 'цщ']);
multi.lines.forEach(row => close(row.font_size_cm, 50 / .72));
close(multi.lines[0].height_cm, 50); close(multi.lines[1].height_cm, 50);
close(multi.lines[2].height_cm, 68 / 72 * 50);
close(multi.lines[1].y_cm, 54); close(multi.lines[2].y_cm, 108);
close(multi.height_cm, (72 + 72 + 68) / 72 * 50 + 8);
assert.equal(multi.lines[1].blank, true);
assert.equal((G.localCompositionSvg({objects: [multi]}).match(/<tspan /g) || []).length, 2);

// A direct measure callback produces the same body scaling as saved metrics,
// and reference text is measured with the object's own font and weight.
const callbackSpec = copy(upperMixed);
delete callbackSpec.preview_line_metrics;
const callbackCalls = [];
const callbackLayout = G.independentObjectLayout(callbackSpec, (text, index, settings) => {
  callbackCalls.push({text, family: settings.font_family, bold: settings.font_bold});
  return text === 'Н' ? metric('Н', 72, 0, 64) : metric(text, 95, 0, 240);
});
assert.deepEqual(callbackLayout, G.independentObjectLayout(upperMixed));
assert.ok(callbackCalls.some(call => call.text === 'Н' && call.family === 'Arial' && call.bold === true));

// Missing, stale or invalid body-reference measurements cannot create a
// seemingly valid metric report. Changing case selection or script invalidates
// the old reference, as do changing font, weight, or the 100px metric size.
for (const change of [
  {height_basis: 'unknown'}, {height_basis: null},
  {height_reference: 'unknown'}, {height_reference: null},
  {preview_line_metrics: {...upperMixed.preview_line_metrics, height_reference: undefined}},
  {preview_line_metrics: {...upperMixed.preview_line_metrics, height_reference: null}},
  {preview_line_metrics: {...upperMixed.preview_line_metrics, height_reference: metric('н', 50)}},
  {preview_line_metrics: {...upperMixed.preview_line_metrics, height_reference: metric('Н', 72, 0, 64, 'Georgia')}},
  {preview_line_metrics: {...upperMixed.preview_line_metrics, height_reference: metric('Н', 72, 0, 64, 'Arial', false)}},
  {preview_line_metrics: {...upperMixed.preview_line_metrics, height_reference: {...metric('Н', 72), actualBoundingBoxAscent: NaN}}},
  {preview_line_metrics: {...upperMixed.preview_line_metrics, height_reference: metric('Н', 0, 0)}},
  {preview_line_metrics: {...upperMixed.preview_line_metrics, height_reference: metric('Н', 10, -20)}},
  {preview_line_metrics: {...upperMixed.preview_line_metrics, height_reference: metric('Н', 72, 0, -1)}},
  {preview_line_metrics: {...upperMixed.preview_line_metrics, font_size_px: 50}},
  {height_reference: 'lowercase'},
]) assert.throws(() => G.independentObjectLayout({...upperMixed, ...change}));
const latinStale = object('HÉ', [metric('HÉ', 95)], metric('Н', 72));
assert.throws(() => G.independentObjectLayout(latinStale));

// Projects created before this field keep their full-bounds contract. Adding
// a valid body measurement alone cannot silently reinterpret a historical size.
const historical = copy(extendedUpper);
delete historical.height_basis; delete historical.height_reference;
const explicitBounds = {...historical, height_basis: 'bounds'};
const historicalLayout = G.independentObjectLayout(historical);
const boundsLayout = G.independentObjectLayout(explicitBounds);
for (const key of ['font_size_cm', 'width_cm', 'height_cm', 'lines', 'bounds_cm'])
  assert.deepEqual(boundsLayout[key], historicalLayout[key], `Legacy ${key}`);
close(historicalLayout.height_cm, 50); close(historicalLayout.font_size_cm, 50 / .95);
const withoutBodyMetrics = copy(historical); delete withoutBodyMetrics.preview_line_metrics.height_reference;
for (const key of ['font_size_cm', 'width_cm', 'height_cm', 'lines', 'bounds_cm'])
  assert.deepEqual(G.independentObjectLayout(withoutBodyMetrics)[key], historicalLayout[key]);

// SVG uses the single body-derived font size and real measured baselines. The
// projected outline and clipping area enclose all ink, including its outliers.
const projected = {...extendedUpper, rotation_deg: 17};
const project = {version: 1, image: {name: 'facade.jpg', width_px: 1200, height_px: 700},
  calibration: {mode: 'frontoparallel', frontoparallel_assumed: true, length_cm: 100,
    image_points: [[20, 20], [220, 20]]}, placement: null,
  sign: {composition_mode: 'independent_signs_v1', objects: [projected]}, measurements: [], checks: []};
const projectBefore = JSON.stringify(project), report = G.analyze(project);
assert.equal(JSON.stringify(project), projectBefore);
const projectedLayout = report.sign_layout.objects[0];
close(projectedLayout.font_size_cm, 50 / .72); close(projectedLayout.height_cm, 95 / 72 * 50);
projectedLayout.polygon_px.forEach((point, i) => G.apply(G.inverse(projectedLayout.local_to_image), point)
  .forEach((value, axis) => close(value, projectedLayout.local_bounds_cm[i][axis])));
const localSvg = G.localCompositionSvg({objects: [projectedLayout]});
const svgFontSize = localSvg.match(/<text\b[^>]*font-size="([^"]+)"/);
assert.ok(svgFontSize); close(Number(svgFontSize[1]), 50 / .72);
assert.ok(localSvg.includes(`<tspan x="${projectedLayout.lines[0].x_cm}" y="${projectedLayout.lines[0].baseline_cm}">НОЙ</tspan>`));
const svg = G.overlaySvg(project, report);
assert.ok(svg.includes('НОЙ')); assert.ok(svg.includes('data-object-id="body"'));
const canonical = P.normalizeProject(project), canonicalBefore = JSON.stringify(canonical);
assert.deepEqual(G.analyze(canonical).sign_layout, report.sign_layout);
assert.equal(JSON.stringify(canonical), canonicalBefore);
assert.ok(G.productPreviewSvg(canonical).includes('НОЙ'));

console.log('PASS: script/case reference selection, uppercase/lowercase Cyrillic and Latin outliers retain one body-derived scale, font/weight-specific references, explicit mixed-case choices, multiline and blank rows, direct measurement parity, stale/invalid reference rejection, historical bounds compatibility, immutable v1/v2 reports and full-ink SVG geometry.');
