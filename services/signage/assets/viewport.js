/* The viewport changes presentation only; project coordinates remain image pixels. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SignageViewport = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const validSize = value => Number.isFinite(value) && value > 0;
  function createModel() {
    let image = null, width = 0, height = 0, scale = 1, x = 0, y = 0, fitScale = 1, minScale = .25, maxScale = 8;
    const snapshot = () => ({image: image ? {...image} : null, width, height, scale, x, y, fitScale, minScale, maxScale});
    function constrain() {
      if (!image) return;
      // Centre an image that fits; magnified images stop at their own edges.
      const imageWidth = image.width_px * scale, imageHeight = image.height_px * scale;
      x = imageWidth <= width ? (width - imageWidth) / 2 : clamp(x, width - imageWidth, 0);
      y = imageHeight <= height ? (height - imageHeight) / 2 : clamp(y, height - imageHeight, 0);
    }
    function fit() {
      if (!image) return snapshot();
      scale = fitScale;
      x = (width - image.width_px * scale) / 2;
      y = (height - image.height_px * scale) / 2;
      return snapshot();
    }
    function configure(nextImage, nextWidth, nextHeight, {reset = false} = {}) {
      if (!validSize(nextWidth) || !validSize(nextHeight)) return snapshot();
      const previousImage = image;
      const center = image ? [(width / 2 - x) / scale, (height / 2 - y) / scale] : null;
      const wasFitted = image && Math.abs(scale - fitScale) < 1e-8 &&
        Math.abs(x - (width - image.width_px * scale) / 2) < 1e-6 && Math.abs(y - (height - image.height_px * scale) / 2) < 1e-6;
      width = nextWidth; height = nextHeight;
      image = nextImage && validSize(nextImage.width_px) && validSize(nextImage.height_px) ?
        {width_px: nextImage.width_px, height_px: nextImage.height_px} : null;
      if (!image) {scale = 1; x = 0; y = 0; fitScale = 1; minScale = .25; maxScale = 8; return snapshot();}
      fitScale = Math.min(Math.max(1, width - 40) / image.width_px, Math.max(1, height - 40) / image.height_px, 1);
      minScale = fitScale / 4;
      maxScale = 8;
      if (reset || !previousImage || previousImage.width_px !== image.width_px || previousImage.height_px !== image.height_px || wasFitted) return fit();
      scale = clamp(scale, minScale, maxScale);
      x = width / 2 - center[0] * scale;
      y = height / 2 - center[1] * scale;
      constrain();
      return snapshot();
    }
    function zoomAt(nextScale, anchorX = width / 2, anchorY = height / 2) {
      if (!image || !Number.isFinite(nextScale) || !Number.isFinite(anchorX) || !Number.isFinite(anchorY)) return snapshot();
      const next = clamp(nextScale, minScale, maxScale), ratio = next / scale;
      x = anchorX - (anchorX - x) * ratio;
      y = anchorY - (anchorY - y) * ratio;
      scale = next;
      constrain();
      return snapshot();
    }
    function zoomBy(factor, anchorX, anchorY) {
      return Number.isFinite(factor) && factor > 0 ? zoomAt(scale * factor, anchorX, anchorY) : snapshot();
    }
    function panBy(dx, dy) {
      if (image && Number.isFinite(dx) && Number.isFinite(dy)) {x += dx; y += dy; constrain();}
      return snapshot();
    }
    function imagePoint(localX, localY) {
      if (!image || !Number.isFinite(localX) || !Number.isFinite(localY) || localX < 0 || localY < 0 || localX > width || localY > height) return null;
      const point = [(localX - x) / scale, (localY - y) / scale];
      return point[0] >= 0 && point[1] >= 0 && point[0] <= image.width_px && point[1] <= image.height_px ? point : null;
    }
    function restore(saved) {
      if (!image || !saved || !validSize(saved.scale) || !validSize(saved.width) || !validSize(saved.height) ||
          !Number.isFinite(saved.x) || !Number.isFinite(saved.y) || saved.image?.width_px !== image.width_px || saved.image?.height_px !== image.height_px) return snapshot();
      scale = clamp(saved.scale, minScale, maxScale);
      x = width / 2 - ((saved.width / 2 - saved.x) / saved.scale) * scale;
      y = height / 2 - ((saved.height / 2 - saved.y) / saved.scale) * scale;
      constrain();
      return snapshot();
    }
    return {configure, fit, zoomAt, zoomBy, panBy, imagePoint, snapshot, restore};
  }
  function mount({viewport, stage, controls, onChange = () => {}}) {
    const model = createModel();
    let pan = null;
    function apply() {
      const state = model.snapshot();
      stage.style.width = state.image ? `${state.image.width_px * state.scale}px` : '100%';
      stage.style.height = state.image ? `${state.image.height_px * state.scale}px` : '100%';
      stage.style.left = `${state.x}px`;
      stage.style.top = `${state.y}px`;
      if (controls.zoomLevel) controls.zoomLevel.textContent = state.image ? `${Math.round(state.scale * 100)}%` : '—';
      if (controls.zoomIn) controls.zoomIn.disabled = !state.image || state.scale >= state.maxScale - 1e-9;
      if (controls.zoomOut) controls.zoomOut.disabled = !state.image || state.scale <= state.minScale + 1e-9;
      for (const control of [controls.zoomFit, controls.zoomActual]) if (control) control.disabled = !state.image;
      onChange(state);
      return state;
    }
    const localPoint = event => {
      const bounds = viewport.getBoundingClientRect();
      return [event.clientX - bounds.left, event.clientY - bounds.top];
    };
    const stopPan = () => {
      const previous = pan;
      pan = null;
      viewport.classList.toggle('is-panning', false);
      if (previous && viewport.hasPointerCapture?.(previous.id)) viewport.releasePointerCapture(previous.id);
    };
    const primaryPress = event => {if (event.button === 0 && !(event.buttons & 4)) stopPan();};
    const ownerDocument = viewport.ownerDocument;
    ownerDocument?.defaultView?.addEventListener('blur', stopPan);
    ownerDocument?.addEventListener('visibilitychange', () => {if (ownerDocument.visibilityState === 'hidden') stopPan();});
    ownerDocument?.addEventListener('pointerdown', primaryPress, true);
    viewport.addEventListener('wheel', event => {
      if (!model.snapshot().image || !Number.isFinite(event.deltaY)) return;
      event.preventDefault();
      const [anchorX, anchorY] = localPoint(event);
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      model.zoomBy(Math.exp(clamp(-event.deltaY * unit * .0018, -1, 1)), anchorX, anchorY);
      apply();
    }, {passive: false});
    viewport.addEventListener('pointerdown', event => {
      // A missed pointerup (for example while changing windows) must not block
      // the next ordinary click used for calibration or ruler points.
      primaryPress(event);
      if (event.button !== 1 || !model.snapshot().image) return;
      event.preventDefault();
      pan = {id: event.pointerId, x: event.clientX, y: event.clientY};
      viewport.setPointerCapture?.(event.pointerId);
      viewport.classList.toggle('is-panning', true);
    });
    viewport.addEventListener('pointermove', event => {
      if (!pan || pan.id !== event.pointerId) return;
      if (typeof event.buttons === 'number' && !(event.buttons & 4)) {stopPan(); return;}
      event.preventDefault();
      model.panBy(event.clientX - pan.x, event.clientY - pan.y);
      pan.x = event.clientX; pan.y = event.clientY;
      apply();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => viewport.addEventListener(type, event => {
      if (pan && (event.pointerId === undefined || event.pointerId === pan.id)) stopPan();
    }));
    viewport.addEventListener('auxclick', event => {if (event.button === 1 && model.snapshot().image) event.preventDefault();});
    // Mousedown must also be cancelled to prevent the browser's native autoscroll.
    viewport.addEventListener('mousedown', event => {if (event.button === 1 && model.snapshot().image) event.preventDefault();});
    viewport.addEventListener('dragstart', event => event.preventDefault());
    if (controls.zoomIn) controls.zoomIn.onclick = () => {model.zoomBy(1.25); apply();};
    if (controls.zoomOut) controls.zoomOut.onclick = () => {model.zoomBy(1 / 1.25); apply();};
    if (controls.zoomActual) controls.zoomActual.onclick = () => {model.zoomAt(1); apply();};
    if (controls.zoomFit) controls.zoomFit.onclick = () => {model.fit(); apply();};
    return {
      configure(image, options) {if (options?.reset || !image) stopPan(); model.configure(image, viewport.clientWidth, viewport.clientHeight, options); return apply();},
      fit() {model.fit(); return apply();},
      restore(saved) {model.restore(saved); return apply();},
      cancelPan: stopPan,
      snapshot: model.snapshot,
      isPanning: () => Boolean(pan)
    };
  }
  return {createModel, mount};
});
