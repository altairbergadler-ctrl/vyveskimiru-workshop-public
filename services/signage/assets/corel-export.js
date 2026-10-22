/* Native CDR creation runs in the installed Windows helper, never in the browser. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const base = new URL('./', window.location.href);
  const storageKey = 'signage-corel-launch:' + base.pathname;
  const pendingStates = new Set(['pending', 'claimed']);
  let packageBusy = false, creating = false, ticket = null, timer = null, polling = false, editorToken = null;
  const number = id => Number($(id).value);
  const objectExportNotice = 'Экспорт независимых текстов и логотипов в CorelDRAW пока недоступен. Сохраните «Схему SVG» или «Схему PNG». Для производства логотипа нужен его векторный оригинал.';
  function independentComposition() {
    // The Windows helper accepts one uniformly formatted text block. Never
    // flatten independent objects into the legacy summary text: their sizes,
    // fonts, positions, rotations and logos would be lost.
    if (window.SignageLetterUI?.hasOverrides?.()) return true;
    const active = window.SignageProductUI?.active?.();
    if (Object.hasOwn(active?.params || {}, 'objects') || active?.params?.composition_mode === 'independent_objects_v1') return true;
    const sign = window.SignageEditor?.snapshot?.().project?.sign;
    return Object.hasOwn(sign || {}, 'objects') || sign?.composition_mode === 'independent_objects_v1';
  }
  function specification() {
    return {text: $('text').value, width_cm: number('signWidth'), height_cm: number('signHeight'),
      line_gap_cm: number('lineGap'), text_align: $('textAlign').value,
      font_family: $('font').value.trim(), font_bold: $('corelBold').checked, front_color: '#000000'};
  }
  function valid(p) {
    if (independentComposition()) return false;
    if(window.SignageProductUI&&!window.SignageProducts.capabilities(window.SignageProductUI.active()).corel)return false;
    const rows = p.text.trim().split(/\r?\n/).length;
    return !!p.text.trim() && !!p.font_family && Number.isFinite(p.width_cm) && p.width_cm > 0 &&
      Number.isFinite(p.height_cm) && p.height_cm > 0 && Number.isFinite(p.line_gap_cm) &&
      p.line_gap_cm >= 0 && (rows - 1) * p.line_gap_cm < p.height_cm;
  }
  function update() {
    const p = specification(), active = ticket && pendingStates.has(ticket.status), objects = independentComposition();
    $('exportCorel').disabled = packageBusy || !valid(p);
    $('exportCorel').textContent = packageBusy ? 'Подготовка ZIP…' : 'Скачать ZIP';
    $('launchCorel').disabled = creating || !!active || !valid(p);
    $('launchCorel').textContent = creating ? 'Подготовка макета…' : active ? 'Ожидаем CorelDRAW…' : 'Создать и открыть в CorelDRAW';
    $('corelOpenAgain').hidden = !ticket || ticket.status !== 'pending';
    if (ticket) $('corelOpenAgain').href = ticket.launch_url;
    else $('corelOpenAgain').removeAttribute('href');
    $('corelSummary').textContent = objects ? objectExportNotice : `${p.width_cm} × ${p.height_cm} см · ${p.font_family || 'укажите шрифт'}${p.font_bold ? ' Bold' : ''} · чёрные векторные буквы`;
    $('launchCorel').title = $('exportCorel').title = objects ? objectExportNotice : '';
    $('corelBold').disabled = objects;
  }
  function status(message) { $('corelStatus').textContent = message; }
  function persist() {
    try {
      if (ticket) sessionStorage.setItem(storageKey, JSON.stringify(ticket));
      else sessionStorage.removeItem(storageKey);
    } catch { /* An unavailable session store does not prevent an explicit launch. */ }
  }
  function parseTicket(value) {
    if (!value || !/^[a-f0-9]{64}$/.test(value.id) ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(value.status_token) ||
        value.launch_url !== 'signage-corel://open/' + value.id) return null;
    return {id: value.id, status_token: value.status_token, launch_url: value.launch_url,
      status: value.status === 'claimed' ? 'claimed' : 'pending'};
  }
  function authExpired() {
    if ($('authExpiredNotice')) $('authExpiredNotice').hidden = false;
    editorToken = null;
    return new Error('Сеанс входа закончился. Войдите в редактор в новой вкладке, затем повторите проверку здесь. Фото и параметры сохранены.');
  }
  async function readResponse(response, fallback) {
    if (response.status === 401) throw authExpired();
    let body;
    try { body = await response.json(); } catch { throw new Error(fallback); }
    if (!response.ok) throw new Error(body.error || fallback);
    return body;
  }
  async function connection() {
    const response = await fetch(new URL('api/config', base));
    const config = await readResponse(response, 'Сервер редактора недоступен.');
    if (!config.token) throw new Error('Не удалось получить подключение редактора.');
    editorToken = config.token;
    if ($('authExpiredNotice')) $('authExpiredNotice').hidden = true;
  }
  function schedulePoll() {
    if (timer !== null) clearTimeout(timer);
    if (ticket && pendingStates.has(ticket.status)) timer = setTimeout(() => { timer = null; poll(); }, 2000);
  }
  async function poll() {
    if (!ticket || polling) return;
    polling = true;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    $('corelCheckStatus').hidden = true;
    const current = ticket;
    try {
      if (!editorToken) await connection();
      const response = await fetch(new URL('api/corel-launch/' + current.id, base), {
        headers: {'X-Editor-Token': editorToken, 'X-Corel-Status-Token': current.status_token}});
      if (response.status === 404) {
        ticket = null; persist(); update();
        status('Срок запроса CorelDRAW закончился. Нажмите «Создать и открыть в CorelDRAW» для нового макета.');
        return;
      }
      const state = await readResponse(response, 'Не удалось проверить CorelDRAW.');
      if (ticket !== current) return;
      if (!['pending', 'claimed', 'complete', 'failed', 'expired'].includes(state.status))
        throw new Error('Сервер вернул неизвестный статус CorelDRAW. Повторите проверку.');
      current.status = state.status;
      if (state.status === 'pending') {
        status('Ожидаем помощник Windows. Если браузер показывает запрос, разрешите открытие. Если CorelDRAW не запускается, нажмите «Открыть CorelDRAW» ниже. На этом ПК должен быть установлен помощник.');
      } else if (state.status === 'claimed') {
        status('Помощник получил макет. CorelDRAW создаёт CDR с чёрными буквами в кривых и открывает его.');
      } else {
        if (state.status === 'complete') status('Готово: ' + (state.filename || 'файл CDR') + '. Файл сохранён на рабочем ПК и открыт в CorelDRAW.');
        if (state.status === 'failed') status(state.message || 'Не удалось создать CDR. Проверьте CorelDRAW на рабочем ПК и повторите создание.');
        if (state.status === 'expired') status('Помощник не завершил запрос вовремя. Проверьте CorelDRAW на ПК перед созданием нового макета.');
        ticket = null;
      }
      persist(); update(); schedulePoll();
    } catch (error) {
      status(error.message || 'Нет связи с сервером редактора.');
      $('corelCheckStatus').hidden = false;
    } finally { polling = false; }
  }
  $('launchCorel').onclick = async () => {
    const payload = specification();
    if (creating || ticket || !valid(payload)) return;
    creating = true; update(); status('Подготавливаем макет для вашего CorelDRAW…');
    try {
      await connection();
      const response = await fetch(new URL('api/corel-launch', base), {method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Editor-Token': editorToken}, body: JSON.stringify(payload)});
      const created = parseTicket(await readResponse(response, 'Не удалось подготовить запуск CorelDRAW.'));
      if (!created) throw new Error('Сервер вернул некорректную ссылку CorelDRAW.');
      ticket = created; persist(); update();
      // The named frame keeps the editor, its URL and its draft in place. An
      // explicit second click on the visible link also works if a browser
      // requires fresh user activation after the asynchronous create request.
      $('corelOpenAgain').click();
      await poll();
    } catch (error) { status(error.message || 'Не удалось запустить CorelDRAW.'); }
    finally { creating = false; update(); }
  };
  $('corelOpenAgain').onclick = () => {
    if (!ticket || ticket.status !== 'pending') return false;
    status('Открываем помощник Windows для этого же макета. При запросе браузера разрешите запуск.');
    schedulePoll();
  };
  $('corelCheckStatus').onclick = async () => { editorToken = null; await poll(); };
  $('exportCorel').onclick = async () => {
    const payload = specification();
    if (packageBusy || !valid(payload)) return;
    packageBusy = true; update(); $('corelPackageStatus').textContent = '';
    try {
      await connection();
      const response = await fetch(new URL('api/corel-package', base), {method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Editor-Token': editorToken}, body: JSON.stringify(payload)});
      if (response.status === 401) throw authExpired();
      if (!response.ok) await readResponse(response, 'Не удалось подготовить пакет CorelDRAW.');
      window.SignageEditor.download(await response.blob(), 'letters-coreldraw-2024.zip', 'application/zip');
      $('corelPackageStatus').textContent = 'ZIP скачан. Распакуйте его на Windows и откройте Create-CDR.vbs. CorelDRAW создаст рядом CDR и отчёт о размерах.';
    } catch (error) { $('corelPackageStatus').textContent = error.message; }
    finally { packageBusy = false; update(); }
  };
  $('corelBold').addEventListener('change', update);
  document.addEventListener('signage:change', update);
  window.SignageCorel = {settings: () => ({font_bold: $('corelBold').checked}),
    restore: sign => { $('corelBold').checked = sign?.font_bold !== false; update(); }};
  try { ticket = parseTicket(JSON.parse(sessionStorage.getItem(storageKey))); } catch { /* No saved request. */ }
  update();
  // Reload only reads the previous status. It never launches a protocol or
  // creates another CDR request automatically.
  if (ticket) { status('Проверяем предыдущий запрос CorelDRAW…'); poll(); }
})();
