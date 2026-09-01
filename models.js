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

  return {
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
