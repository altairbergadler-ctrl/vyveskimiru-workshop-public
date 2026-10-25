/* Local autosave: the photo and project are atomic in IndexedDB; the small journal
   preserves the latest edits on a fast reload without putting a photo in localStorage. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./products.js') : root.SignageProducts);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.SignageDraft = api;
    const key = new URL('.', root.location.href).pathname;
    const controller = api.createController({store: api.openStore(root.indexedDB), editor: root.SignageEditor,
      generation: root.SignageGeneration, status: root.document.getElementById('draftStatus'),
      document: root.document, window: root, key});
    root.SignageDraft.ready = controller.start();
    root.SignageDraft.flush = controller.flush;
  }
})(typeof window !== 'undefined' ? window : globalThis, function (Products) {
  'use strict';
  function openStore(indexedDB) {
    let opening;
    function open() {
      if (opening) return opening;
      opening = new Promise((resolve, reject) => {
        if (!indexedDB) {reject(new Error('Браузер не предоставляет локальное хранилище.')); return;}
        const request = indexedDB.open('signage-editor-drafts', 1);
        request.onupgradeneeded = () => {if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts');};
        request.onerror = () => reject(request.error || new Error('Не удалось открыть локальное хранилище.'));
        request.onblocked = () => reject(new Error('Хранилище заблокировано другой вкладкой.'));
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => {database.close(); opening = null;};
          resolve(database);
        };
      });
      return opening;
    }
    async function transaction(key, value, write) {
      const database = await open();
      return new Promise((resolve, reject) => {
        const tx = database.transaction('drafts', write ? 'readwrite' : 'readonly');
        const request = write ? tx.objectStore('drafts').put(value, key) : tx.objectStore('drafts').get(key);
        let answer;
        request.onsuccess = () => {answer = request.result;};
        tx.oncomplete = () => resolve(answer);
        tx.onerror = tx.onabort = () => reject(tx.error || request.error || new Error('Не удалось сохранить черновик.'));
      });
    }
    return {read: key => transaction(key, undefined, false), write: (key, value) => transaction(key, value, true)};
  }
  const artworkReferences = new Map();
  function artworkReference(data) {
    if(artworkReferences.has(data))return artworkReferences.get(data);
    let forward=2166136261,reverse=2166136261;
    for(let i=0;i<data.length;i++){forward=Math.imul(forward^data.charCodeAt(i),16777619);reverse=Math.imul(reverse^data.charCodeAt(data.length-i-1),16777619);}
    const value=`${data.length}:${(forward>>>0).toString(16)}:${(reverse>>>0).toString(16)}`;
    if(artworkReferences.size>12)artworkReferences.clear();artworkReferences.set(data,value);return value;
  }
  function mapArtwork(value,transform) {
    if(Array.isArray(value))return value.map(item=>mapArtwork(item,transform));
    if(!value||typeof value!=='object')return value;
    if(value.mime_type==='image/png'&&(typeof value.data_url==='string'||typeof value._draft_artwork_ref==='string'))return transform(value);
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,mapArtwork(item,transform)]).filter(([,item])=>item!==undefined));
  }
  function packArtworkMetadata(snapshot) {
    return mapArtwork(snapshot,artwork=>{const {data_url,...metadata}=artwork;return {...metadata,_draft_artwork_ref:artworkReference(data_url)};});
  }
  function savedArtworkReferences(snapshot) {
    const data=new Map();mapArtwork(snapshot,artwork=>{if(typeof artwork.data_url==='string')data.set(artworkReference(artwork.data_url),artwork.data_url);return artwork;});return data;
  }
  function hydrateArtworkMetadata(snapshot,savedSnapshot) {
    const data=savedArtworkReferences(savedSnapshot);
    return mapArtwork(snapshot,artwork=>{
      if(!artwork._draft_artwork_ref)return artwork;
      const source=data.get(artwork._draft_artwork_ref),{_draft_artwork_ref,...metadata}=artwork;
      if(source)return {...metadata,data_url:source};
      // Text PNGs can be rebuilt from preserved form values. A missing uploaded
      // original must never be replaced with generated text or a different PNG.
      if(artwork.source==='text')return undefined;
      throw new Error('Последний загруженный оригинал не успел сохраниться.');
    });
  }
  function createController({store, editor, generation, status, document, window, key, delay = 180}) {
    const search = new URLSearchParams(window.location.search);
    const explicitHistory = search.has('restoreJob') || search.has('restoreProject') || search.get('newProject') === '1';
    const journalKey = `signage-draft-journal:${key}`;
    let ready = false, restoring = false, userEpoch = 0, edited = false, timer = null, latest = null;
    let revision = 0, savedRevision = 0, writing = null, savedPhotoKey = null, journalOK = true, savedArtwork = new Map(), requiredOriginals = [];
    const setStatus = (message, error = false) => {
      if (!status) return;
      status.textContent = message;
      status.classList?.toggle('error', error);
    };
    const clone = Products.copyData;
    function journal(record) {
      try {
        const {photo, ...metadata} = record.snapshot;
        const packed=packArtworkMetadata(metadata);requiredOriginals=[];mapArtwork(packed,artwork=>{if(artwork.source==='uploaded')requiredOriginals.push(artwork._draft_artwork_ref);return artwork;});
        const text = JSON.stringify({...record, snapshot: packed});
        if (text.length > 512 * 1024) throw new Error('Слишком большой проект для журнала быстрого восстановления.');
        window.localStorage.setItem(journalKey, text);
        journalOK = true;
      } catch (_) {journalOK = false;}
    }
    function capture() {
      const snapshot = editor.draftSnapshot();
      const {photo, ...metadata} = snapshot;
      return {version: 1, saved_at: new Date().toISOString(), snapshot: {...clone(metadata), photo}, generation: clone(generation?.draftState?.() || null)};
    }
    function schedule() {
      if ((restoring && !edited) || (!edited && !editor.snapshot().hasPhoto)) return;
      try {
        latest = capture(); revision++;
        journal(latest);
        if (!ready) return;
        clearTimeout(timer);
        setStatus('Сохраняю черновик на этом устройстве…');
        if (latest.snapshot.photoKey !== savedPhotoKey) void flush();
        else timer = setTimeout(() => {void flush();}, delay);
      } catch (_) {journalOK = false; setStatus('Не удалось подготовить черновик. Сохраните проект JSON перед закрытием страницы.', true);}
    }
    async function flush() {
      clearTimeout(timer); timer = null;
      if (!ready || !latest || savedRevision === revision) return;
      if (writing) return writing;
      writing = (async () => {
        while (savedRevision < revision) {
          const record = latest, targetRevision = revision;
          try {await store.write(key, record);}
          catch (_) {setStatus('Черновик не сохранён: локальное хранилище недоступно или заполнено. Сохраните проект JSON и исходное фото.', true); return;}
          savedRevision = targetRevision;
          savedPhotoKey = record.snapshot.photoKey;
          savedArtwork=savedArtworkReferences(record.snapshot);
        }
        setStatus('Черновик сохранён на этом устройстве. После обновления страницы работа восстановится.');
      })();
      try {await writing;} finally {writing = null;}
    }
    function intent(event) {
      if (event.isTrusted === false) return;
      if (event.type === 'keydown' && ['Control','Shift','Alt','Meta'].includes(event.key)) return;
      userEpoch++; edited = true;
    }
    // Capture user intent before file readers or other asynchronous imports start.
    ['pointerdown','keydown','input','change'].forEach(type => document.addEventListener(type, intent, true));
    ['input','change'].forEach(type => document.addEventListener(type, () => schedule()));
    ['signage:change','signage:viewchange','signage:resultchange','signage:workspacechange'].forEach(type => document.addEventListener(type, schedule));
    document.addEventListener('visibilitychange', () => {if (document.visibilityState === 'hidden') void flush();});
    window.addEventListener('pagehide', () => {void flush();});
    window.addEventListener('beforeunload', event => {
      if (latest && savedRevision < revision && (latest.snapshot.photoKey !== savedPhotoKey || !journalOK || requiredOriginals.some(reference=>!savedArtwork.has(reference)))) {
        void flush(); event.preventDefault(); event.returnValue = '';
      }
    });
    async function start() {
      setStatus('Проверяю сохранённый черновик на этом устройстве…');
      const startingEpoch = userEpoch;
      let record, draftRestored = false, unmatchedJournal = false;
      try {
        record = await store.read(key);
        savedPhotoKey = record?.snapshot?.photoKey || null;savedArtwork=savedArtworkReferences(record?.snapshot);
        try {
          const recent = JSON.parse(window.localStorage.getItem(journalKey) || 'null');
          if (recent?.version === 1 && recent.snapshot && (!record || recent.saved_at >= record.saved_at)) {
            if (recent.snapshot.photoKey === savedPhotoKey){try{record={...recent,snapshot:{...hydrateArtworkMetadata(recent.snapshot,record?.snapshot),photo:record?.snapshot?.photo||''}};}catch{unmatchedJournal=true;}}
            else unmatchedJournal = true;
          }
        } catch (_) { /* A damaged journal never replaces the complete IndexedDB record. */ }
        if (!explicitHistory && record?.version === 1 && record.snapshot && userEpoch === startingEpoch && !editor.snapshot().hasPhoto) {
          restoring = true;
          const shouldApply = () => userEpoch === startingEpoch;
          draftRestored = await editor.restoreDraft(record.snapshot, {shouldApply});
          // Slow loading of a previous AI result must never suspend saving new edits.
          restoring = false; ready = true;
          if (draftRestored && shouldApply()) {
            await generation?.ready;
            if (shouldApply()) await generation?.restoreDraft?.(record.generation, {shouldApply});
          }
        }
        if (unmatchedJournal && draftRestored) setStatus('Восстановлен предыдущий черновик. Последнее новое фото или оригинал макета не успели сохраниться.', true);
        else if (draftRestored) setStatus('Черновик восстановлен. Изменения сохраняются на этом устройстве.');
        else setStatus('Изменения автоматически сохраняются в этом браузере.');
      } catch (_) {setStatus('Не удалось полностью восстановить локальный черновик. Используйте сохранённый JSON или историю.', true);}
      finally {
        restoring = false; ready = true;
        // A user import wins over an old asynchronous read; only the current state is saved.
        if (edited) schedule();
        else if (latest) void flush();
      }
      return {restored: draftRestored, record};
    }
    return {start, schedule, flush};
  }
  return {openStore,createController,packArtworkMetadata,hydrateArtworkMetadata};
});
