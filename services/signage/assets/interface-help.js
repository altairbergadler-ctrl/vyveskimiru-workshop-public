/* On-demand help; editor-owned nodes stay in the live DOM. */
(() => {
  'use strict';
  const root = document.documentElement;
  const $ = id => document.getElementById(id);
  const dialog = $('interfaceHelpDialog');
  const groups = [
    ['Фотография и проект', '#interfacePhotoPanel .interface-step-heading h2', '#interfacePhotoPanel .interface-step-heading>p,#interfacePhotoPanel>.hint:not(#draftStatus)'],
    ['Масштаб фотографии', '#interfaceScalePanel .interface-step-heading h2', '#interfaceScalePanel .interface-step-heading>p'],
    ['Масштаб по отрезку', '#referenceLength', '#frontFields>.hint'],
    ['Масштаб с перспективой', '#referenceWidth', '#rectangleFields>.hint'],
    ['Изделие и каталог', '#productSection .interface-step-heading h2', '#productSection .interface-step-heading>p,#productFamilyNote,#productCoverageNote,#productSection>.hint:last-child'],
    ['Готовый вариант', '#productTemplate', '#interfaceTemplateHint,#catalogSelectionNote'],
    ['Текст изделия', '#text', '#textHint'],
    ['Габарит изделия', '#signWidth', '#interfaceSizeHint'],
    ['Материалы и подсветка', '#faceMaterialType', '#filmMaterialFields>.hint,#filmColorHint'],
    ['Неоновая форма', '#neonBacking', '#neonFields>.hint'],
    ['Параметры для производства', '#brief', '#materialPriorityHint,.interface-production-note,#interfaceProductionToggle small'],
    ['Размещение изделия', '#rotation', '#placementHint'],
    ['Создание макета', '#interfaceResultPanel .interface-step-heading h2', '#interfaceResultPanel .interface-step-heading>p,#productGenerationNote,#generationReady'],
    ['Освещение и геометрия', '#lighting', '#lightingHint,.geometry-lock>span'],
    ['Подготовка фона с ИИ', '#productAiBackground', '#backgroundAiHint'],
    ['Зона замены', '#editRegion', '#interfaceResultPanel>.hint:not([id]),#editRegionState'],
    ['Подключение ChatGPT', '#subscriptionSettings>b', '#subscriptionSettings>.hint'],
    ['Работа с фотографией и линейкой', '.toolbar', '.view-controls>small,#rulerInfo>p,#instruction,#interfaceEmptyHint'],
    ['Перспектива и границы установки', '#facadeControls', '#facadeHelp'],
    ['Точный макет PNG', '#artworkTitle', '#exactArtworkSection>.hint:not(#artworkStatus),#artworkStatus'],
    ['Экспорт в CorelDRAW', '#corelTitle', '#corelSection>.hint:not([id])'],
    ['Цвета результата', '.result-specification>b', '.result-specification>.hint:not(#resultMaterial)'],
    ['Просмотр результата', '.preview-actions', '.preview-actions>.hint'],
    ['Визуализация и техническая схема', '#status h2', '#footerNote']
  ];
  const conditional = new Set(['generationReady', 'connectionMessage', 'artworkStatus', 'instruction', 'rulerReadout', 'editRegionState']);
  let activeGroup = null, opener = null;

  function sourceText(source) {
    if (source.closest('[hidden]')) return '';
    const copy = source.cloneNode(true);
    copy.querySelectorAll('[hidden]').forEach(node => node.remove());
    return copy.textContent.trim();
  }
  function contents(group) {
    return [...new Set(group.sources.map(sourceText).filter(Boolean))];
  }
  function renderHelp() {
    if (!activeGroup) return;
    $('interfaceHelpTitle').textContent = activeGroup.title;
    $('interfaceHelpContent').replaceChildren(...contents(activeGroup).map(text => {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      return paragraph;
    }));
  }
  function closeHelp() {if (dialog.open) dialog.close();}
  function refresh() {
    if (root.dataset.interface !== 'redesign') closeHelp();
    // Availability reasons, failures and running operations remain on screen.
    $('generationReady').toggleAttribute('data-interface-help-source', !$('generate').disabled);
    $('connectionMessage').toggleAttribute('data-interface-help-source', $('connectionBadge').textContent.trim() === 'Codex подключён' && $('authExpiredNotice').hidden);
    $('artworkStatus').toggleAttribute('data-interface-help-source', !window.SignageProductUI?.active().artwork && !$('artworkStatus').classList.contains('product-error'));
    // Current point counts and the ruler-limit error are operational feedback.
    const instruction = $('instruction');
    instruction.toggleAttribute('data-interface-help-source', !/^Отмечено \d+ из \d+\.|^В линейке уже 256 точек\./.test(instruction.textContent));
    $('rulerReadout').toggleAttribute('data-interface-help-source', /^Добавьте ещё одну точку|^Нажимайте на фото/.test($('rulerReadout').textContent));
    $('editRegionState').toggleAttribute('data-interface-help-source', /^Укажите (область|зону)/.test($('editRegionState').textContent));
    groups.forEach(group => {group.button.hidden = !contents(group).length;});
    if (dialog.open) renderHelp();
  }
  async function initialize() {
    const state = await window.SignageInterface.ready;
    if (!state.available || !dialog || typeof dialog.showModal !== 'function') return {available:false};
    groups.forEach((definition, index) => {
      const [title, selector, sources] = definition;
      const target = document.querySelector(selector);
      const group = {title, sources:[...document.querySelectorAll(sources)]};
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'interface-help-button';
      const symbol = document.createElement('span');
      symbol.textContent = '?'; symbol.setAttribute('aria-hidden', 'true'); button.append(symbol);
      button.dataset.interfaceHelp = String(index);
      button.setAttribute('aria-label', `Подсказка: ${title}`);
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-controls', 'interfaceHelpDialog');
      const label = target.closest('label');
      if (label) {
        const control = label.querySelector('input,select,textarea');
        // Keep the original label associated with its field, never the help button.
        if (!label.htmlFor) label.htmlFor = control.id;
        const caption = document.createElement('span');
        caption.id = `interfaceHelpLabel-${index}`;
        const preceding = [...label.childNodes].slice(0, [...label.childNodes].indexOf(control));
        caption.append(...preceding); label.insertBefore(caption, control);
        if (!control.hasAttribute('aria-label') && !control.hasAttribute('aria-labelledby')) control.setAttribute('aria-labelledby', caption.id);
        label.insertBefore(button, control);
      }
      else if (target.matches('button')) target.after(button);
      else target.append(button);
      group.button = button;
      group.sources.forEach(source => {if (!conditional.has(source.id)) source.setAttribute('data-interface-help-source', '');});
      button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        if (root.dataset.interface !== 'redesign') return;
        activeGroup = group; opener = button; renderHelp(); dialog.showModal();
      });
      groups[index] = group;
    });
    $('interfaceHelpClose').addEventListener('click', closeHelp);
    // Editor shortcuts must not alter a ruler while the native modal is open.
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeHelp();
    });
    dialog.addEventListener('close', () => {
      activeGroup = null;
      if (root.dataset.interface === 'redesign' && opener?.isConnected && !opener.hidden) opener.focus({preventScroll:true});
      opener = null;
    });
    const observer = new MutationObserver(refresh);
    new Set(groups.flatMap(group => group.sources)).forEach(source => observer.observe(source, {childList:true,subtree:true,attributes:true,attributeFilter:['hidden','class']}));
    ['generate','connectionBadge','authExpiredNotice','productSection','lettersFields','plaqueFields','neonFields','exactArtworkSection','subscriptionSettings','rulerInfo'].forEach(id => observer.observe($(id), {childList:id === 'connectionBadge',attributes:true,attributeFilter:['hidden','disabled']}));
    observer.observe(root, {attributes:true,attributeFilter:['data-interface']});
    document.addEventListener('signage:change', refresh);
    root.dataset.interfaceHelpReady = 'true';
    refresh();
    return {available:true, groups:groups.length};
  }
  window.SignageHelp = {ready:initialize()};
})();
