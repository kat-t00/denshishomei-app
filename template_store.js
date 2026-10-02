// テンプレート（PDFと配置定義）はIndexedDBに保存。旧localStorageは書込み完了後に移行する。
// 個人情報を含まないデータ(PDF書式そのものと座標定義のみ)なので自動保存してよい。
const TemplateStore = (() => {
  const STORAGE_KEY = 'keiyaku_templates_v1';

  const MAX_PDF_BYTES = 20 * 1024 * 1024;
  let database = null;
  let templatesCache = [];
  let initialization = null;
  let writes = Promise.resolve();

  function init() {
    if (initialization) return initialization;
    initialization = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('このブラウザでは書式の保存機能を使えません。')); return; }
      const opening = indexedDB.open(STORAGE_KEY + '_database', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('state');
      opening.onerror = () => reject(opening.error);
      opening.onblocked = () => reject(new Error('別のタブが保存領域を使用しています。古いタブを閉じて再読み込みしてください。'));
      opening.onsuccess = () => {
        database = opening.result;
        database.onversionchange = () => database.close();
        let legacy = null;
        let legacyTemplates;
        try {
          legacy = localStorage.getItem(STORAGE_KEY);
          legacyTemplates = legacy ? JSON.parse(legacy) : [];
          if (!Array.isArray(legacyTemplates)) throw new Error('既存書式の形式が正しくありません。元のデータは削除していません。');
        } catch (error) { reject(error); return; }
        const transaction = database.transaction('state','readwrite');
        const store = transaction.objectStore('state');
        const reading = store.get('templates');
        let saved;
        let migrated = false;
        let migrationError;
        reading.onsuccess = () => {
          saved = reading.result;
          if (!saved) {
            try { saved = legacyTemplates; store.put(saved,'templates'); migrated = true; }
            catch(error) { migrationError = error; transaction.abort(); return; }
          }
          if (!Array.isArray(saved)) { transaction.abort(); return; }
        };
        transaction.oncomplete = () => {
          templatesCache = saved;
          // 移行先の書込み完了後だけ旧データを解放。同時に旧版が更新した場合は残す。
          try { if (migrated && legacy && localStorage.getItem(STORAGE_KEY) === legacy) localStorage.removeItem(STORAGE_KEY); }
          catch(error) { console.warn('旧書式データは移行済みですが旧保存領域を解放できませんでした',error); }
          resolve();
        };
        transaction.onabort = () => reject(migrationError || transaction.error || new Error('書式の移行を完了できませんでした。元のデータは削除していません。'));
        transaction.onerror = () => {};
      };
    });
    return initialization;
  }

  function loadAll() { return structuredClone(templatesCache); }

  function storageError(error) {
    const message = error && error.name === 'QuotaExceededError'
      ? '端末の保存容量が不足しています。'
      : 'ブラウザの保存領域に書き込めませんでした。';
    return new Error(message + '編集内容はこの画面に残っています。「編集中の書式をバックアップ」で退避できます。\n（詳細: ' + (error && error.message || '不明') + '）');
  }

  function changeTemplates(change) {
    const operation = writes.then(async () => {
      await init();
      return new Promise((resolve,reject) => {
        const transaction = database.transaction('state','readwrite');
        const store = transaction.objectStore('state');
        const reading = store.get('templates');
        let next, result, failure;
        reading.onsuccess = () => {
          try {
            next = reading.result || [];
            result = change(next);
            store.put(next,'templates');
          } catch(error) { failure = error.name === 'QuotaExceededError' ? storageError(error) : error; transaction.abort(); }
        };
        transaction.oncomplete = () => { templatesCache = structuredClone(next); resolve(result); };
        transaction.onabort = () => reject(failure || storageError(transaction.error));
        transaction.onerror = () => {};
      });
    });
    writes = operation.catch(() => {});
    return operation;
  }

  function checkPdfSize(template) {
    const encoded = String(template.pdfBase64 || '').replace(/\s/g,'');
    const bytes = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    if (bytes > MAX_PDF_BYTES) throw new Error('PDFは1書式20MBまでです。PDFを軽量化してから選択してください。');
  }

  async function getStorageInfo() {
    await init();
    let estimate = null;
    try { if (navigator.storage && navigator.storage.estimate) estimate = await navigator.storage.estimate(); } catch (_) {}
    return {templateCount:templatesCache.length,pdfBytes:templatesCache.reduce((total,t)=>total+Math.floor((t.pdfBase64 || '').length*3/4),0),estimate};
  }

  // 将来スキーマが変わっても古い保存データが壊れないように、読込時に必ず補正する
  function normalizeField(field) {
    const f = Object.assign({}, field);
    if (!f.type) f.type = Models.FIELD_TYPES.SIGNATURE;
    if (!(typeof f.width === 'number' && isFinite(f.width) && f.width > 0)) f.width = 120;
    if (!(typeof f.height === 'number' && isFinite(f.height) && f.height > 0)) f.height = 40;
    if (!(typeof f.x === 'number' && isFinite(f.x))) f.x = 0;
    if (!(typeof f.y === 'number' && isFinite(f.y))) f.y = 0;
    if (f.type === 'date' && !f.dateFormat) f.dateFormat = 'gregorian';
    // Models.createFieldのデフォルトと揃える(2026/8/8変更: 「どちらでも」が基本、続柄欄だけ「家族」)
    if (!f.assignedRole) f.assignedRole = (f.type === 'relationship') ? 'family' : 'either';
    if (f.linkedFieldId === undefined) f.linkedFieldId = null;
    if (!(typeof f.fontSize === 'number' && isFinite(f.fontSize) && f.fontSize > 0)) f.fontSize = 11;
    if (!(typeof f.signatureScale === 'number' && isFinite(f.signatureScale) && f.signatureScale > 0)) f.signatureScale = 100;
    if (!(typeof f.signOrder === 'number')) f.signOrder = 1;
    if (typeof f.required !== 'boolean') f.required = true;
    if (typeof f.label !== 'string') f.label = '';
    return f;
  }

  function normalizeTemplate(t) {
    const normalized = Object.assign({}, t, {
      signingMode: t.signingMode || 'legacy',
      requireAdditionalForScribe: !!t.requireAdditionalForScribe,
      version: typeof t.version === 'number' ? t.version : 1,
      familyId: t.familyId || t.id,
      supersededBy: t.supersededBy || null,
      isArchived: !!t.isArchived,
      hasSignedSessions: !!t.hasSignedSessions,
      pages: (t.pages || []).map(p => Object.assign({}, p, {
        fields: (p.fields || []).map(normalizeField),
      })),
    });
    // 署名欄が1つしかないテンプレートでは、付随項目の紐付け漏れを自動で補う
    // (単一署名欄が今の標準形のため、ほとんどのケースをここで無音解決できる)。
    // 署名欄が2つ以上ある場合は「どちらの署名欄の項目か」を機械的に推測できないため
    // 補わない(誤って推測すると、印字先が入れ替わる事故を防ぐ目的自体が崩れるため)。
    const signatureFields = [];
    normalized.pages.forEach(p => p.fields.forEach(f => { if (f.type === 'signature') signatureFields.push(f); }));
    if (signatureFields.length === 1) {
      const onlyId = signatureFields[0].id;
      normalized.pages.forEach(p => p.fields.forEach(f => {
        if (f.type !== 'signature' && !f.linkedFieldId) f.linkedFieldId = onlyId;
      }));
    }
    return normalized;
  }

  // 一覧表示用の軽量な情報だけ返す(PDF本体は含まない)
  function list() {
    return loadAll()
      .map(normalizeTemplate)
      .filter(t => !t.isArchived)
      .map(t => ({
        id: t.id,
        familyId: t.familyId,
        name: t.name,
        version: t.version,
        versionLabel: t.versionLabel,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        pageCount: t.pages.length,
        hasSignedSessions: t.hasSignedSessions,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function get(id) {
    const t = loadAll().find(t => t.id === id) || null;
    return t ? normalizeTemplate(t) : null;
  }

  function saveNew(template) {
    return changeTemplates(templates => { checkPdfSize(template); templates.push(template); });
  }

  function saveEdit(template) {
    return changeTemplates(templates => {
      checkPdfSize(template);
      const index = templates.findIndex(t => t.id === template.id);
      if (index < 0) { templates.push(template); return template; }
      const existing = normalizeTemplate(templates[index]);
      if (!existing.hasSignedSessions) {
        templates[index] = Object.assign({},template,{updatedAt:new Date().toISOString()});
        return templates[index];
      }
      const newVersion = Object.assign({},template,{id:Models.makeId('tpl'),familyId:existing.familyId,
        version:existing.version+1,supersededBy:null,hasSignedSessions:false,
        createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
      templates[index] = Object.assign({},existing,{supersededBy:newVersion.id,isArchived:true});
      templates.push(newVersion);
      return Object.assign({},newVersion,{versionedFrom:existing.version});
    });
  }

  function markSigned(id) {
    return changeTemplates(templates => {
      const index = templates.findIndex(t => t.id === id);
      if (index >= 0) templates[index] = Object.assign({},templates[index],{hasSignedSessions:true});
    });
  }

  function remove(id) {
    return changeTemplates(templates => {
      const index = templates.findIndex(t => t.id === id);
      if (index >= 0) templates.splice(index,1);
    });
  }

  function exportAll() {
    return loadAll().map(normalizeTemplate);
  }

  // 選んだテンプレートだけをバックアップ対象にする(取り込み先で全部が必要とは限らないため)
  function exportSelected(ids) {
    const idSet = new Set(ids);
    return loadAll().map(normalizeTemplate).filter(t => idSet.has(t.id));
  }

  async function importAll(templates) {
    if (!Array.isArray(templates)) throw new Error('バックアップファイルの形式が正しくありません');

    // 途中まで保存せず、全項目を検証してから一度だけ保存する。
    const imported = templates.map(t => {
      if (!(t && typeof t.id === 'string' && typeof t.name === 'string' && t.name.trim() && Array.isArray(t.pages) && t.pages.every(p => p && Array.isArray(p.fields) && p.fields.every(f => f && typeof f === 'object')))) throw new Error('バックアップ内の書式の形式が正しくありません。変更は保存していません。');
      if (typeof t.pdfBase64 !== 'string' || !/^JVBERi0[A-Za-z0-9+/=\s]*$/.test(t.pdfBase64)) throw new Error('バックアップ内のPDFデータが正しくありません。');
      const errors = Models.validateTemplate(t);
      if (errors.length) throw new Error('バックアップ内の書式を修正してください。\n' + errors.join('\n'));
      checkPdfSize(t);
      return normalizeTemplate(t);
    });
    return changeTemplates(current => {
    imported.forEach(t => {
      if (current.some(c => c.id === t.id)) {
        // 既存書式と署名実績を一切書き換えない。
        t = Object.assign({}, t, {id: Models.makeId('tpl'), familyId: Models.makeId('tplfam'), name: t.name + '（取り込み）', supersededBy: null, isArchived: false});
      }
      current.push(t);
    });
    return imported.length;
    });
  }

  return {
    init, MAX_PDF_BYTES, getStorageInfo, list, get, saveNew, saveEdit, markSigned, remove, exportAll, exportSelected, importAll,
    normalizeTemplate, normalizeField,
  };
})();
