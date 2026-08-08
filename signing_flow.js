// 同一端末で複数人が順番に署名する時の状態管理(状態機械)。
// SigningSessionはメモリ内だけで保持し、localStorageには一切保存しない
// (個人情報を含むデータを自動保存しない、というhouse styleの方針のため)。
const SigningFlow = (() => {
  let session = null;
  let queue = []; // 署名待ちのfield配列(signOrder順)
  let queueIndex = 0;
  let seqCounter = 0;

  function logEvent(type, extra) {
    seqCounter += 1;
    session.eventLog.push(Object.assign(Models.createEventLogEntry(type, extra), { seq: seqCounter }));
  }

  function startSession(template, recipientName, resignOf) {
    session = Models.createSigningSession({
      templateId: template.id,
      templateFamilyId: template.familyId,
      templateVersion: template.version,
      templateVersionLabel: template.versionLabel,
      recipientName: recipientName || '',
      resignOf: resignOf || null,
    });
    seqCounter = 0;
    logEvent('session_started');

    const signatureFields = [];
    template.pages.forEach(page => {
      page.fields.forEach(field => {
        if (field.type === 'signature') signatureFields.push(field);
      });
    });
    queue = signatureFields.sort((a, b) => a.signOrder - b.signOrder);
    queueIndex = 0;
    return session;
  }

  function getSession() { return session; }
  function isQueueComplete() { return queueIndex >= queue.length; }
  function getCurrentField() { return isQueueComplete() ? null : queue[queueIndex]; }
  function getProgress() { return { current: queueIndex + (isQueueComplete() ? 0 : 1), total: queue.length }; }

  // 署名者が入力を終えて確定した時に呼ぶ
  function submitCurrentSigner(input) {
    const field = getCurrentField();
    if (!field) throw new Error('署名待ちの項目がありません');
    // 署名欄はテンプレート側で本人/家族を固定しない設計のため、役割は必ずその場(input.role)で選ばれる
    const role = input.role;
    if (!role) throw new Error('署名する立場（本人／ご家族）を選択してください');
    if (!input.typedName || !input.typedName.trim()) throw new Error('氏名が入力されていません');
    if (role === 'family' && !input.declarationChecked) {
      throw new Error('代理権限の確認チェックが必要です');
    }
    if (!input.signatureImageDataUrl) throw new Error('署名が入力されていません');

    const signer = Models.createSigner({
      role,
      order: field.signOrder,
      fieldId: field.id,
      typedName: input.typedName.trim(),
      relationship: input.relationship || null,
      address: input.address || null,
      declarationChecked: !!input.declarationChecked,
      confirmedDeclarations: input.confirmedDeclarations || [],
      signedAt: new Date().toISOString(),
      signatureImageDataUrl: input.signatureImageDataUrl,
    });
    session.signers.push(signer);
    logEvent('signer_signed', { signerId: signer.signerId, role: signer.role, typedName: signer.typedName });
    queueIndex += 1;
    return signer;
  }

  // 必須項目にしていない署名欄を、今回は不要と判断してスキップする場合に呼ぶ
  function skipCurrentField() {
    const field = getCurrentField();
    if (!field) return;
    if (field.required) throw new Error('必須の署名欄はスキップできません');
    logEvent('signer_skipped', { fieldId: field.id, assignedRole: field.assignedRole });
    queueIndex += 1;
  }

  // 「やり直す」ボタン等で、直前に確定した署名を取り消してもう一度させる場合
  function redoLastSigner() {
    if (session.signers.length === 0) return;
    const last = session.signers.pop();
    logEvent('signer_redo', { signerId: last.signerId });
    queueIndex = Math.max(0, queueIndex - 1);
  }

  function completeSession() {
    session.status = 'completed';
    session.completedAt = new Date().toISOString();
    logEvent('session_completed');
  }

  return {
    startSession, getSession, isQueueComplete, getCurrentField, getProgress,
    submitCurrentSigner, skipCurrentField, redoLastSigner, completeSession,
  };
})();
