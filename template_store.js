// テンプレート（署名欄を配置したPDFの定義）をlocalStorageに保存・読込する。
// 個人情報を含まないデータ(PDF書式そのものと座標定義のみ)なので自動保存してよい。
const TemplateStore = (() => {
  const STORAGE_KEY = 'keiyaku_templates_v1';

  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error('テンプレートの読込に失敗しました', e);
      return [];
    }
  }

  function saveAll(templates) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
    } catch (e) {
      // テンプレートはPDF本体(base64)を含むため、編集・署名を重ねるうちに
      // ブラウザのlocalStorage上限(5〜10MB程度)に達することがある(QuotaExceededError)。
      // 呼び出し元(app.js)で必ずキャッチして事業所に日本語で伝えられるよう、分かりやすい理由を付けて投げ直す
      console.error('テンプレートの保存に失敗しました', e);
      throw new Error('テンプレートの保存に失敗しました。ブラウザの保存容量が上限に達している可能性があります。「テンプレートをバックアップ」で保存してから、使わなくなった署名済みテンプレートを削除してください。');
    }
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
    if (!(typeof f.signOrder === 'number')) f.signOrder = 1;
    if (typeof f.required !== 'boolean') f.required = true;
    if (typeof f.label !== 'string') f.label = '';
    return f;
  }

  function normalizeTemplate(t) {
    return Object.assign({}, t, {
      version: typeof t.version === 'number' ? t.version : 1,
      familyId: t.familyId || t.id,
      supersededBy: t.supersededBy || null,
      isArchived: !!t.isArchived,
      hasSignedSessions: !!t.hasSignedSessions,
      pages: (t.pages || []).map(p => Object.assign({}, p, {
        fields: (p.fields || []).map(normalizeField),
      })),
    });
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
    const templates = loadAll();
    templates.push(template);
    saveAll(templates);
  }

  // 既存テンプレートを保存する。ただし既に署名実績がある場合は上書きせず、
  // 新バージョン(同じfamilyId・version+1)を作り、旧版にsupersededByを設定する。
  // これにより「この契約はどの版の書式に同意したか」を過去に遡って追跡できる。
  function saveEdit(template) {
    const templates = loadAll();
    const idx = templates.findIndex(t => t.id === template.id);
    if (idx < 0) {
      saveNew(template);
      return template;
    }
    const existing = normalizeTemplate(templates[idx]);
    if (!existing.hasSignedSessions) {
      templates[idx] = Object.assign({}, template, { updatedAt: new Date().toISOString() });
      saveAll(templates);
      return templates[idx];
    }
    const newVersion = Object.assign({}, template, {
      id: Models.makeId('tpl'),
      familyId: existing.familyId,
      version: existing.version + 1,
      supersededBy: null,
      hasSignedSessions: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // 署名実績のある旧版は一覧から見えなくする(データは残るので過去の契約の追跡には使える)
    templates[idx] = Object.assign({}, existing, { supersededBy: newVersion.id, isArchived: true });
    templates.push(newVersion);
    saveAll(templates);
    return Object.assign({}, newVersion, { versionedFrom: existing.version });
  }

  // 署名が完了した時に呼び、以後このテンプレートを編集したら新バージョンになるよう印を付ける
  function markSigned(id) {
    const templates = loadAll();
    const idx = templates.findIndex(t => t.id === id);
    if (idx >= 0) {
      templates[idx] = Object.assign({}, templates[idx], { hasSignedSessions: true });
      saveAll(templates);
    }
  }

  function remove(id) {
    saveAll(loadAll().filter(t => t.id !== id));
  }

  function exportAll() {
    return loadAll().map(normalizeTemplate);
  }

  // 選んだテンプレートだけをバックアップ対象にする(取り込み先で全部が必要とは限らないため)
  function exportSelected(ids) {
    const idSet = new Set(ids);
    return loadAll().map(normalizeTemplate).filter(t => idSet.has(t.id));
  }

  function importAll(templates) {
    if (!Array.isArray(templates)) throw new Error('バックアップファイルの形式が正しくありません');
    const current = loadAll();
    templates.forEach(t => {
      if (!(t && t.id && t.name && Array.isArray(t.pages))) return;
      const idx = current.findIndex(c => c.id === t.id);
      if (idx >= 0) current[idx] = t; else current.push(t);
    });
    saveAll(current);
    return templates.length;
  }

  return {
    list, get, saveNew, saveEdit, markSigned, remove, exportAll, exportSelected, importAll,
    normalizeTemplate, normalizeField,
  };
})();
