// データの形を作るだけの純粋な関数群。DOM操作・保存処理は一切行わない。
const Models = (() => {
  function makeId(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  // 署名欄の種類。それぞれ画面での見た目・入力内容が変わる
  const FIELD_TYPES = {
    SIGNATURE: 'signature',
    DATE: 'date',
    NAME: 'name',
    RECIPIENT_NAME: 'recipient_name',
    RECIPIENT_ADDRESS: 'recipient_address',
    RELATIONSHIP: 'relationship',
    DECLARATION_CHECKBOX: 'declaration_checkbox',
    ADDRESS: 'address',
  };

  const SIGNER_ROLES = {
    RECIPIENT: 'recipient', // 利用者本人
    FAMILY: 'family', // 家族代理
  };

  function createField(overrides) {
    const field = Object.assign({
      id: makeId('f'),
      type: FIELD_TYPES.SIGNATURE,
      x: 0, // PDFポイント座標（左下原点）
      y: 0,
      width: 120,
      height: 40,
      // 「どちらでも」をデフォルトにする(署名欄は常にその場で本人/家族を選ぶ設計になったため、
      // 付随項目もどちらの署名でも自動で埋まる形が一番手間が少ない。役割を絞りたい時だけ明示的に変える)
      assignedRole: 'either',
      // どの署名欄の付随項目か(氏名欄・住所欄・続柄欄・日付欄・確認チェック欄で使用)。
      // PDF書き込み時はこのIDで紐付いた署名欄の署名者のデータだけを印字する。
      // 役割(assignedRole)だけでマッチングすると、署名欄が複数ある時に別の署名欄の
      // データが誤って印字される事故が実際にあったため導入した(field_editor.jsで自動/手動設定)
      linkedFieldId: null,
      signOrder: 1,
      required: true,
      label: '',
      fontSize: overrides && overrides.type === FIELD_TYPES.DATE ? 16 : 14, // 新規の日付欄は16pt、他の活字欄は14pt。指定済みサイズは維持する。
      signatureScale: 100, // 署名欄のみ使用。枠に収めた(object-fit:contain)後にさらに掛ける表示サイズ(%)
    }, overrides);
    // 続柄欄だけは例外: 「本人から見た続柄」は本人が自分に対して書く概念が存在しないため、
    // 明示的な指定が無ければ「家族」をデフォルトにする(「どちらでも」にすると本人選択時にも
    // 空欄の続柄欄が意味なく表示されてしまう)
    if (field.type === FIELD_TYPES.RELATIONSHIP && !('assignedRole' in overrides)) {
      field.assignedRole = 'family';
    }
    return field;
  }

  function createTemplate(overrides) {
    const now = new Date().toISOString();
    return Object.assign({
      id: makeId('tpl'),
      familyId: makeId('tplfam'),
      version: 1,
      versionLabel: '',
      name: '',
      signingMode: 'single',
      requireAdditionalForScribe: true,
      createdAt: now,
      updatedAt: now,
      pdfBase64: '',
      pages: [], // [{ widthPt, heightPt, fields: [] }]
      supersededBy: null,
      isArchived: false,
      // このテンプレートで一度でも署名が完了したことがあるか。
      // trueになったら編集保存時に新バージョンを作る必要がある(template_store.js側で判定)
      hasSignedSessions: false,
    }, overrides);
  }

  function createSigner(overrides) {
    return Object.assign({
      signerId: makeId('signer'),
      role: SIGNER_ROLES.RECIPIENT,
      order: 1,
      fieldId: null,
      typedName: '',
      relationship: null,
      address: null,
      building: '',
      signingCapacity: 'self', // 'self' | 'scribe' | 'representative' | 'additional'
      recipientConsentConfirmed: false,
      authorityBasis: null,
      declarationChecked: false,
      confirmedDeclarations: [], // 事業所が配置した確認チェック欄(重要事項説明を聞きました等)のラベル一覧
      signedAt: null,
      signatureImageDataUrl: null,
      // Phase 2（遠隔署名）で使う予約項目。MVPでは常にsame_device
      deliveryMethod: 'same_device',
      remoteAccessToken: null,
    }, overrides);
  }

  function createEventLogEntry(type, extra) {
    return Object.assign({
      seq: 0, // signing_flow.js側で連番を振る
      at: new Date().toISOString(),
      type: type, // 'session_started' | 'signer_signed' | 'signer_redo' | 'session_completed' | 'session_voided'
    }, extra || {});
  }

  function createSigningSession(overrides) {
    const now = new Date().toISOString();
    return Object.assign({
      sessionId: makeId('sess'),
      templateId: null,
      templateFamilyId: null,
      templateVersion: null,
      templateVersionLabel: '',
      verificationId: (crypto.randomUUID ? crypto.randomUUID() : makeId('verify')),
      startedAt: now,
      status: 'in_progress', // 'in_progress' | 'completed' | 'void'
      recipientName: '',
      recipientAddress: '',
      recipientBuilding: '',
      signers: [],
      eventLog: [],
      completedAt: null,
      finalPdfHashSha256: null,
      hasExplanationAudio: false, // 重要事項説明の音声記録を添付したか
      explanationAudioHashSha256: null, // 音声ファイルのSHA-256(改ざん検知用、PDFハッシュと同じ考え方)
      ipAddress: null, // MVPでは取得しない(常時ネットワーク依存を避けるため)。Phase 2の予約項目
      userAgent: (typeof navigator !== 'undefined' ? navigator.userAgent : ''),
      tsaToken: null, // Phase 2（TSA連携）の予約項目
      voidInfo: null, // { voidedAt, reason, voidedBy, previousPdfHash }
      resignOf: null, // { previousPdfHash, previousVerificationId, voidReason }
    }, overrides);
  }

  // テンプレート保存・署名開始・PDF出力で同じ設定不備を検出する。
  function validateTemplate(template) {
    const errors = [];
    const labels = { signature: '署名欄', name: '署名者氏名欄', recipient_name: '利用者氏名欄', recipient_address: '利用者住所欄', address: '署名者住所欄', date: '日付欄', relationship: '続柄欄', declaration_checkbox: '確認チェック欄' };
    const pages = template.pages || [];
    if (!Array.isArray(pages) || pages.some(page => !page || !Array.isArray(page.fields))) return ['ページの形式が正しくありません。'];
    if (pages.some(page => !Number.isFinite(page.widthPt) || !Number.isFinite(page.heightPt) || page.widthPt <= 0 || page.heightPt <= 0)) errors.push('PDFのページサイズが正しくありません。');
    const fields = pages.flatMap(page => page.fields || []);
    const signatures = fields.filter(field => field.type === 'signature');
    if (template.signingMode && !['single','optional','all','legacy'].includes(template.signingMode)) errors.push('署名方法を選び直してください。');
    if (!signatures.length) errors.push('署名欄を1つ以上配置してください。');
    if (template.signingMode === 'single' && signatures.length !== 1) errors.push('1人で完結する書式は署名欄を1つにしてください。複数人が署名する書式は署名方法を変更してください。');
    if (['optional','all'].includes(template.signingMode) && signatures.length < 2) errors.push('追加の署名欄を配置してください。1人で完結する書式なら署名方法を変更してください。');
    if (template.requireAdditionalForScribe && template.signingMode === 'optional' && signatures.length !== 2) errors.push('代筆時の家族署名を必須にする書式は、本人用と家族用の署名欄を1つずつ配置してください。');
    if (['optional','all'].includes(template.signingMode) && new Set(signatures.map(field => field.signOrder)).size !== signatures.length) errors.push('署名する順番が重複しています。本人または代理人の欄を先頭にし、異なる順番を指定してください。');
    const ids = new Set();
    pages.forEach((page, index) => (page.fields || []).forEach(field => {
      const label = (index + 1) + 'ページ目「' + (field.label || labels[field.type] || field.type) + '」';
      if (!field.id || ids.has(field.id)) errors.push(label + 'の項目IDが重複または欠落しています。');
      ids.add(field.id);
      if (['address','recipient_address'].includes(field.type) && field.addressRows != null && ![2,3,4].includes(field.addressRows)) errors.push(label + 'の行数を選び直してください。');
      if (field.type === 'declaration_checkbox' && field.checkPrintStyle && !['check','confirmed'].includes(field.checkPrintStyle)) errors.push(label + 'のチェック印字形式が未対応です。');
      if (!Object.values(FIELD_TYPES).includes(field.type)) errors.push(label + 'の項目の種類が未対応です。');
      if (field.assignedRole && !['either','recipient','family','additional'].includes(field.assignedRole)) errors.push(label + 'の表示条件が正しくありません。');
      if (field.type === 'signature' && (!Number.isInteger(field.signOrder) || field.signOrder < 1)) errors.push(label + 'の署名順を正の整数にしてください。');
      const validRect = [field.x,field.y,field.width,field.height].every(Number.isFinite) && field.width > 0 && field.height > 0;
      if (!validRect || field.x < 0 || field.y < 0 || field.x + field.width > page.widthPt + 0.01 || field.y + field.height > page.heightPt + 0.01) {
        errors.push(label + 'をページ内に収まる位置・大きさにしてください。');
      }
      if (field.type === 'signature') {
        const scale = (field.signatureScale ?? 100) / 100;
        if (!Number.isFinite(scale) || scale < 0.5 || scale > 2) errors.push(label + 'の表示サイズは50〜200%にしてください。');
        else if (field.x - field.width * (scale - 1) / 2 < 0 || field.y - field.height * (scale - 1) / 2 < 0 || field.x + field.width * (scale + 1) / 2 > page.widthPt || field.y + field.height * (scale + 1) / 2 > page.heightPt) {
          errors.push(label + 'の拡大後の署名がページ外にはみ出します。位置または表示サイズを調整してください。');
        }
      } else {
        if (!['recipient_name','recipient_address'].includes(field.type) && !signatures.some(sig => sig.id === field.linkedFieldId)) errors.push(label + 'を署名欄に紐付けてください。');
        const size = field.fontSize ?? 11;
        if (!Number.isFinite(size) || size < 6 || size > 36) errors.push(label + 'の文字サイズは6〜36ptにしてください。');
      }
    }));
    return errors;
  }

  function getSignerFields(template, signatureFieldId, role, types) {
    // 追加署名は家族の氏名・住所・続柄欄も使えるが、代理権などの確認チェックは共有しない。
    return (template.pages || []).flatMap(page => page.fields || []).filter(field =>
      types.includes(field.type) &&
      field.linkedFieldId === signatureFieldId &&
      (!field.assignedRole || field.assignedRole === 'either' || field.assignedRole === role ||
        (role === 'additional' && field.assignedRole === 'family')));
  }

  function fullAddress(address, building) {
    return [address,building].map(value => String(value || '').trim()).filter(Boolean).join('\n');
  }

  return {
    validateTemplate,
    getSignerFields,
    fullAddress,
    makeId,
    FIELD_TYPES,
    SIGNER_ROLES,
    createField,
    createTemplate,
    createSigner,
    createEventLogEntry,
    createSigningSession,
  };
})();
