/* Native choices share the existing saved generation values. */
(() => {
  'use strict';
  const choices = [...document.querySelectorAll('[data-generation-choice]')];
  function sync() {
    for (const choice of choices) {
      const field = document.getElementById(choice.dataset.generationChoice);
      choice.checked = field?.value === choice.value;
    }
  }
  for (const choice of choices) choice.addEventListener('change', () => {
    if (!choice.checked) return;
    const field = document.getElementById(choice.dataset.generationChoice);
    field.value = choice.value;
    field.dispatchEvent(new Event('change', {bubbles: true}));
    sync();
  });
  for (const event of ['signage:change', 'signage:resultchange']) document.addEventListener(event, sync);
  for (const owner of [window.SignageGeneration, window.SignageDraft, window.SignageWorkspace]) owner?.ready?.then(sync);
  const reconnect = () => {
    if (document.visibilityState === 'visible') window.SignageGeneration?.checkConnection();
  };
  window.addEventListener('online', reconnect);
  window.addEventListener('focus', reconnect);
  document.addEventListener('visibilitychange', reconnect);
  sync();
})();
