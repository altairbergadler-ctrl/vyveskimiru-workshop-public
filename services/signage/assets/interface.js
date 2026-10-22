/* One current presentation; readiness controls navigation, never the design. */
(() => {
  'use strict';
  const root = document.documentElement;
  const $ = id => document.getElementById(id);
  const stepButtons = [...document.querySelectorAll('[data-interface-step-button]')];
  const storageKey = `signage-interface-v1:${new URL('.', location.href).pathname}`;
  // History's owner removes restoreJob after opening its source photo. Capture
  // the initial request before readiness work can change that query parameter.
  const initialRestoreId = new URLSearchParams(location.search).get('restoreJob');
  const initialHistoryRestore = /^[a-zA-Z0-9_-]{16,80}$/.test(initialRestoreId || '');
  let enabled = false, currentStep = '1', frame = 0, workspaceRequested = false;
  let lastResult = false, resizePending = false;
  const validMode = value => value === 'redesign';
  const validStep = value => /^[1-4]$/.test(String(value));
  const mode = () => 'redesign';
  const cssAvailable = () => getComputedStyle(root).getPropertyValue('--signage-interface-css-ready').trim() === '1';

  // A disabled control can still send pointerdown to document capture. Draft's
  // capture listener treats this as editing, so stop only our own early input at
  // window capture, before it reaches the draft module. The control is also
  // disabled until restoration finishes.
  function guardEarlyInput(event) {
    if (enabled || !event.target?.closest?.('[data-interface-step-button],#interfaceProductionToggle,#interfaceWorkspaceToggle')) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }
  window.addEventListener('pointerdown', guardEarlyInput, true);
  window.addEventListener('click', guardEarlyInput, true);

  function resizeView() {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      // The existing viewport.configure keeps scale/center or adapts fitted view
      // to the available space. No point, field, job or project is replaced.
      window.dispatchEvent(new Event('resize'));
    });
  }
  function retainFocusedField() {
    const active = document.activeElement;
    if (!active || !active.matches?.('input,textarea,select,button,a')) return;
    for (let node = active.parentElement; node && node !== document.body; node = node.parentElement) {
      if (node.matches('[data-interface-panel],.interface-production-field,.workspace')) node.dataset.interfaceFocusRetained = '';
    }
  }
  function releaseRetainedFocus() {
    document.querySelectorAll('[data-interface-focus-retained]').forEach(node => {
      if (!node.contains(document.activeElement)) delete node.dataset.interfaceFocusRetained;
    });
  }
  function updateNavigation() {
    root.dataset.interfaceStep = currentStep;
    stepButtons.forEach(button => {
      if (button.closest('#interfaceSteps') && button.dataset.interfaceStepButton === currentStep) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    });
  }
  function setStep(value) {
    if (!enabled || !validStep(value)) return false;
    retainFocusedField(); currentStep = String(value); updateNavigation(); resizeView();
    return true;
  }
  function preferredMode() {
    // Old bookmarks and browser preferences cannot re-enable the retired UI.
    return 'redesign';
  }
  function setMode(value, {persist = true} = {}) {
    if (!enabled || !validMode(value)) return false;
    if (!cssAvailable()) {fallback(); return false;}
    const next = 'redesign';
    if (next === 'redesign') {
      // Switching through the API while typing retains the field and selection.
      const focusedPanel = document.activeElement?.closest?.('[data-interface-panel]');
      if (focusedPanel) currentStep = focusedPanel.dataset.interfacePanel.split(' ')[0];
      retainFocusedField();
      if (document.activeElement?.closest?.('.interface-production-field')) setProductionOpen(true);
    }
    root.dataset.interface = next;
    if (persist) try {localStorage.setItem(storageKey, next);} catch (_) {}
    updateNavigation(); resizeView();
    return next === value;
  }
  function setProductionOpen(open) {
    if (!enabled) return false;
    if (!open) retainFocusedField();
    root.dataset.interfaceProductionOpen = String(Boolean(open));
    $('interfaceProduction').dataset.productionOpen = String(Boolean(open));
    $('interfaceProductionToggle').setAttribute('aria-expanded', String(Boolean(open)));
    return true;
  }
  function updateWorkspace() {
    const result = !$('aiResult').hidden;
    let action = '';
    try {action = window.SignageEditor.draftSnapshot().interaction.action;} catch (_) {}
    if (result && !lastResult && !action) workspaceRequested = false;
    lastResult = result;
    const showWorkspace = workspaceRequested || Boolean(action);
    root.dataset.interfaceResult = String(result);
    root.dataset.interfaceWorkspace = showWorkspace ? 'visible' : 'auto';
    const button = $('interfaceWorkspaceToggle');
    button.hidden = !result;
    button.textContent = showWorkspace ? 'Скрыть рабочую фотографию' : 'Показать рабочую фотографию';
    button.setAttribute('aria-expanded', String(showWorkspace));
  }
  function refresh() {
    frame = 0;
    if (!enabled) return;
    const state = window.SignageEditor.snapshot(), project = state.project;
    const saveElement = $('serverProjectStatus') || $('draftStatus');
    const draftText = saveElement.textContent.trim();
    const saveError = saveElement.classList.contains('error') || /не удалось|не сохранён|не успели/.test(draftText.toLowerCase());
    const saved = !saveError && /^(?:Черновик (?:сохранён|восстановлен)|Проект сохранён на сервере|Проект загружен с сервера|Открыт сохранённый вариант)/.test(draftText);
    const saveLabel = saveError ? 'Правки: требуется внимание' : saved ? 'Проект на сервере' : /^Сохраняю|сохраняю/.test(draftText) ? 'Сохраняем проект…' : 'Автосохранение включено';
    $('interfaceSaveStatus').textContent = saveLabel;
    $('interfaceSaveStatus').title = draftText;
    $('interfaceSaveStatus').dataset.saveState = saveError ? 'error' : saved ? 'ready' : 'pending';
    const connectionText = $('connectionBadge').textContent.trim();
    const connectionButton = $('interfaceConnection');
    const composite = window.SignageProductUI?.generationEngine() === 'composite';
    const connectionReady = connectionText === 'Codex подключён';
    const serverOnline = connectionReady || connectionText === 'Codex пока не подключён';
    const checkingConnection = /Проверка/.test(connectionText);
    const authExpired = !$('authExpiredNotice').hidden;
    connectionButton.querySelector('span').textContent = authExpired ? 'Требуется вход' : composite && serverOnline ? 'Точный макет · без ИИ' : connectionText;
    connectionButton.dataset.connectionState = authExpired ? 'error' : checkingConnection ? 'pending' : serverOnline && (composite || connectionReady) ? 'ready' : 'error';
    connectionButton.title = authExpired ? $('authExpiredNotice').textContent.trim() : composite && serverOnline ? 'Точный PNG размещается без запроса ИИ. Открыть настройки результата.' : $('connectionMessage').textContent.trim();
    $('interfacePhotoState').textContent = state.hasPhoto ? `✓ Фото загружено · ${project.image?.name || 'Исходное фото'}` : '';
    let calibrated = false;
    if (state.hasPhoto) try {window.LetterGeometry.calibrate(project.calibration); calibrated = true;} catch (_) {}
    const generation = window.SignageGeneration.draftState();
    const product = window.SignageProductUI?.active();
    const uploadedRequired = product && window.SignageProducts && (window.SignageProducts.capabilities(product).require_uploaded===true || window.SignageProducts.family(product).artwork_mode === 'upload_only');
    const independent=project.sign?.composition_mode==='independent_signs_v1';
    const textReady = independent?Boolean(project.sign.objects?.length):uploadedRequired ? product?.artwork?.source === 'uploaded' : Boolean(project.sign?.text?.trim() || product?.artwork?.source === 'uploaded');
    const hasResult = Boolean(generation.jobId && !$('aiResult').hidden);
    const complete = [state.hasPhoto, calibrated, Boolean(state.report?.placement && textReady && state.report.placement.fits_target !== false&&(!independent||project.target_polygon_px)), hasResult && $('resultStale').hidden];
    const labels = [state.hasPhoto ? 'Фото загружено' : 'Фото не загружено', calibrated ? 'Масштаб рассчитан' : 'Масштаб не задан', complete[2] ? 'Вывеска размещена' : 'Размещение не задано', hasResult ? ($('resultStale').hidden ? 'Результат готов' : 'Показан предыдущий результат') : generation.pendingJobId ? 'Задание выполняется' : 'Результат не создан'];
    document.querySelectorAll('#interfaceSteps [data-interface-step-button]').forEach((button, index) => {
      button.dataset.complete = String(complete[index]);
      button.dataset.state = index === 3 && generation.pendingJobId ? 'running' : complete[index] ? 'complete' : 'incomplete';
      button.querySelector('.interface-step-state').setAttribute('aria-label', labels[index]);
      button.title = labels[index];
    });
    updateWorkspace();
  }
  function queueRefresh() {if (enabled && !frame) frame = requestAnimationFrame(refresh);}
  function fallback() {
    // Keep this same DOM and current styling. Without navigation, every panel
    // stays reachable, including advanced settings and the working photo.
    delete root.dataset.interfaceReady;
    root.dataset.interface = 'redesign';
    root.dataset.interfaceHelpReady = 'false';
    root.dataset.interfaceProductionOpen = 'true';
    root.dataset.interfaceWorkspace = 'visible';
    stepButtons.forEach(button => {button.disabled = true;});
    if ($('interfaceProductionToggle')) $('interfaceProductionToggle').disabled = true;
    if ($('interfaceWorkspaceToggle')) $('interfaceWorkspaceToggle').disabled = true;
    enabled = false;
  }
  async function initialize() {
    try {
      // Generation also resumes its stored job in a separate continuation after
      // draft restoration. Let that continuation run before choosing the step.
      // This waits only for existing readiness work, without starting any I/O.
      await Promise.all([window.SignageDraft.ready, window.SignageGeneration?.ready, window.SignageWorkspace?.ready]);
      await Promise.resolve();
      if (!cssAvailable() || !window.SignageEditor || !window.SignageGeneration) {fallback(); return {mode: mode(), available: false};}
      const initial = window.SignageEditor.snapshot();
      const action = window.SignageEditor.draftSnapshot().interaction.action;
      const pendingJob = window.SignageGeneration.draftState().pendingJobId;
      const openingHistory = initialHistoryRestore || /^Открываю сохранённый проект и исходное фото/.test($('generationStatus').textContent);
      currentStep = action === 'reference' || action === 'measure' ? '2' : action === 'place' || action === 'target' ? '3' : action === 'editRegion' || openingHistory || pendingJob || !$('aiResult').hidden ? '4' : initial.hasPhoto ? (initial.report?.placement ? '3' : '2') : '1';
      enabled = true;
      stepButtons.forEach(button => {button.disabled = false;});
      $('interfaceProductionToggle').disabled = false;
      $('interfaceWorkspaceToggle').disabled = false;
      setProductionOpen(false);
      stepButtons.forEach(button => button.addEventListener('click', () => setStep(button.dataset.interfaceStepButton)));
      $('interfaceProductionToggle').addEventListener('click', () => setProductionOpen($('interfaceProduction').dataset.productionOpen !== 'true'));
      $('interfaceWorkspaceToggle').addEventListener('click', () => {workspaceRequested = root.dataset.interfaceWorkspace !== 'visible'; updateWorkspace(); resizeView();});
      // Existing click handlers still own each geometry action.
      ['editRegion', 'useTarget'].forEach(id => $(id).addEventListener('click', () => {workspaceRequested = true; updateWorkspace(); resizeView();}));
      document.addEventListener('focusout', () => queueMicrotask(releaseRetainedFocus));
      document.addEventListener('focusin', event => {
        if (mode() !== 'redesign') return;
        const advanced = event.target.closest?.('.interface-production-field');
        if (advanced) setProductionOpen(true);
      });
      ['signage:change', 'signage:resultchange', 'signage:workspacestatus'].forEach(type => document.addEventListener(type, queueRefresh));
      const observer = new MutationObserver(queueRefresh);
      ['draftStatus','connectionBadge','connectionMessage','authExpiredNotice','aiResult','resultStale','generate','generationStatus','resumeGeneration'].forEach(id => observer.observe($(id), {childList:true,subtree:true,attributes:true,attributeFilter:['hidden','disabled','class']}));
      setMode(preferredMode(), {persist:false}); refresh();
      root.dataset.interfaceReady = 'true';
      // CSS failure exposes every current panel without changing editor state.
      $('interfaceStyles').addEventListener('error', fallback);
      return {mode:mode(), available:true};
    } catch (error) {
      fallback();
      console.warn('Не удалось включить навигацию по шагам. Все разделы редактора доступны на одной странице.', error);
      return {mode:mode(), available:false};
    }
  }
  window.SignageInterface = {ready:initialize(),setMode,setStep,setProductionOpen,mode,step:()=>currentStep,storageKey};
})();
