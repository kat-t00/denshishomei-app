// 同一端末で複数人が順番に署名する時の状態管理(状態機械)。
// SigningSessionはメモリ内だけで保持し、localStorageには一切保存しない
// (個人情報を含むデータを自動保存しない、というhouse styleの方針のため)。
const SigningFlow = (() => {
  let session = null;
  let currentTemplate = null;
  let queue = []; // 署名待ちのfield配列(signOrder順)
  let queueIndex = 0;
  let seqCounter = 0;

  function logEvent(type, extra) {
    seqCounter += 1;
    session.eventLog.push(Object.assign(Models.createEventLogEntry(type, extra), { seq: seqCounter }));
  }

  function startSession(template, recipientName, resignOf, plan) {
    const mode = template.signingMode || 'legacy';
    const requiresRecipientAddress = template.pages.some(page => page.fields.some(field => field.type === 'recipient_address' && field.required));
    if (requiresRecipientAddress && !String(plan && plan.recipientAddress || '').trim()) {
      throw new Error('利用者住所欄を印字するため、利用者住所を入力してください。');
    }
    if (mode !== 'legacy') {
      if (!recipientName || !recipientName.trim()) throw new Error('利用者氏名を入力してください。');
      if (!plan || !['recipient','family'].includes(plan.primaryRole)) throw new Error('署名する方を選んでください。');
      if (mode === 'optional' && typeof plan.includeAdditional !== 'boolean') throw new Error('追加署名の要否を選んでください。');
      if (mode === 'optional' && template.requireAdditionalForScribe &&
          plan.primaryRole === 'family' && plan.primaryCapacity === 'scribe' && !plan.includeAdditional) {
        throw new Error('この書式では、本人名を家族が代筆した後に家族本人の署名も必要です。');
      }
    }
    session = Models.createSigningSession({
      templateId: template.id,
      templateFamilyId: template.familyId,
      templateVersion: template.version,
      templateVersionLabel: template.versionLabel,
      recipientName: recipientName || '',
      recipientAddress: plan && plan.recipientAddress || '',
      recipientBuilding: plan && plan.recipientBuilding || '',
      resignOf: resignOf || null,
      signingMode: mode,
      signingPlan: plan ? Object.assign({ primaryCapacity: plan.primaryRole === 'family' ? 'representative' : 'self' }, plan) : null,
    });
    currentTemplate = template;
    seqCounter = 0;
    logEvent('session_started');

    const signatureFields = [];
    template.pages.forEach(page => {
      page.fields.forEach(field => {
        if (field.type === 'signature') signatureFields.push(field);
      });
    });
    queue = signatureFields.sort((a, b) => a.signOrder - b.signOrder);
    if (mode === 'single' && queue.length !== 1) throw new Error('1人用の書式には署名欄を1つ配置してください。');
    if (mode === 'optional' && !plan.includeAdditional) {
      queue.slice(1).forEach(field => logEvent('signer_skipped', { fieldId: field.id, reason: 'additional_not_required' }));
      queue = queue.slice(0, 1);
    }
    queueIndex = 0;
    return session;
  }

  function getSession() { return session; }
  function isQueueComplete() { return queueIndex >= queue.length; }
  function getCurrentField() { return isQueueComplete() ? null : queue[queueIndex]; }
  function getProgress() { return { current: queueIndex + (isQueueComplete() ? 0 : 1), total: queue.length }; }
  function getReusableScribeDetails() {
    if (!session || isQueueComplete() || getPlannedRole() !== 'additional') return null;
    const previous = session.signers[session.signers.length - 1];
    if (!previous || previous.role !== 'family' || !['scribe','representative'].includes(previous.signingCapacity)) return null;
    return { typedName: previous.typedName, address: previous.address || '', building: previous.building || '', relationship: previous.relationship || '' };
  }
  function getPlannedRole() {
    if (!session || session.signingMode === 'legacy') return null;
    return queueIndex === 0 ? session.signingPlan.primaryRole : 'additional';
  }

  function getPlannedCapacity() {
    if (!session || session.signingMode === 'legacy') return null;
    return queueIndex === 0 ? session.signingPlan.primaryCapacity : 'additional';
  }

  // 署名者が入力を終えて確定した時に呼ぶ
  function submitCurrentSigner(input) {
    const field = getCurrentField();
    if (!field) throw new Error('署名待ちの項目がありません');
    // 署名欄はテンプレート側で本人/家族を固定しない設計のため、役割は必ずその場(input.role)で選ばれる
    const role = input.role;
    if (!['recipient','family','additional'].includes(role)) throw new Error('署名する立場を選択してください');
    if (getPlannedRole() && role !== getPlannedRole()) throw new Error('署名前に確認した立場と一致しません。');
    if (!input.typedName || !input.typedName.trim()) throw new Error('氏名が入力されていません');
    const previousSigner = session.signers[session.signers.length - 1];
    if (currentTemplate.requireAdditionalForScribe && session.signingMode === 'optional' &&
        previousSigner && previousSigner.signingCapacity === 'scribe' &&
        input.typedName.trim() !== previousSigner.typedName) {
      throw new Error('先ほど代筆したご家族本人が、続けてご自身の欄に署名してください。');
    }
    const plannedCapacity = getPlannedCapacity();
    const signingCapacity = role === 'recipient' ? 'self'
      : role === 'additional' ? 'additional'
      : input.signingCapacity || plannedCapacity || 'representative';
    if (plannedCapacity && signingCapacity !== plannedCapacity) throw new Error('署名前に確認した署名方法と一致しません。');
    if (signingCapacity === 'scribe' && !input.recipientConsentConfirmed) throw new Error('本人の意思を確認したうえで、代筆の確認をしてください。');
    if (signingCapacity === 'representative') {
      if (!input.declarationChecked) throw new Error('代理権限の確認チェックが必要です');
      if (!input.authorityBasis || !input.authorityBasis.trim()) throw new Error('代理権の根拠を記録してください。');
    }
    const signerFields = Models.getSignerFields(currentTemplate, field.id, role, ['address', 'relationship']);
    const requiredSignerFields = signerFields.filter(linked => linked.required);
    if (requiredSignerFields.some(linked => linked.type === 'address') && !String(input.address || '').trim()) {
      throw new Error('この書式には記入者住所欄があります。住所を入力してください。');
    }
    if (requiredSignerFields.some(linked => linked.type === 'relationship') && !String(input.relationship || '').trim()) {
      throw new Error('この書式には続柄欄があります。続柄を入力してください。');
    }
    if (!input.signatureImageDataUrl) throw new Error('署名が入力されていません');
    const declarations = Models.getSignerFields(currentTemplate, field.id, role, ['declaration_checkbox']);
    const confirmedIds = new Set(input.confirmedDeclarationIds || []);
    if (declarations.some(item => item.required && !confirmedIds.has(item.id))) throw new Error('この書式の必須の確認事項にチェックしてください。');

    // 本人自署のときは「利用者住所」と「署名者住所」は同じ人の情報。
    // 署名画面で訂正されたら、PDFの両欄で違う住所にならないよう一緒に更新する。
    if (role === 'recipient' && signerFields.some(linked => linked.type === 'address')) {
      const confirmedAddress = String(input.address || '').trim();
      const requiredRecipientAddress = currentTemplate.pages.some(page => page.fields.some(linked =>
        linked.type === 'recipient_address' && linked.required));
      if (requiredRecipientAddress && !confirmedAddress) throw new Error('利用者住所欄に必要な住所を入力してください。');
      if (session.recipientAddress !== confirmedAddress) {
        session.recipientAddress = confirmedAddress;
        if (session.signingPlan) session.signingPlan.recipientAddress = confirmedAddress;
        logEvent('recipient_address_updated', { reason: 'recipient_confirmed' });
      }
      session.recipientBuilding = String(input.building || '').trim();
      if (session.signingPlan) session.signingPlan.recipientBuilding = session.recipientBuilding;
    }

    const signer = Models.createSigner({
      role,
      order: field.signOrder,
      fieldId: field.id,
      typedName: input.typedName.trim(),
      relationship: input.relationship || null,
      address: input.address || null,
      building: String(input.building || '').trim(),
      signingCapacity,
      recipientConsentConfirmed: !!input.recipientConsentConfirmed,
      authorityBasis: input.authorityBasis ? input.authorityBasis.trim() : null,
      declarationChecked: !!input.declarationChecked,
      confirmedDeclarations: declarations.filter(item => confirmedIds.has(item.id)).map(item => item.label || '内容を確認しました'),
      confirmedDeclarationIds: declarations.filter(item => confirmedIds.has(item.id)).map(item => item.id),
      signedAt: new Date().toISOString(),
      signatureImageDataUrl: input.signatureImageDataUrl,
    });
    session.signers.push(signer);
    logEvent('signer_signed', { signerId: signer.signerId, role: signer.role, signingCapacity: signer.signingCapacity, typedName: signer.typedName, recipientConsentConfirmed: signer.recipientConsentConfirmed, authorityBasis: signer.authorityBasis });
    queueIndex += 1;
    return signer;
  }

  // 必須項目にしていない署名欄を、今回は不要と判断してスキップする場合に呼ぶ
  function skipCurrentField() {
    const field = getCurrentField();
    if (!field) return;
    if (session.signingMode !== 'legacy' || field.required) throw new Error('今回必要な署名は省略できません');
    logEvent('signer_skipped', { fieldId: field.id, assignedRole: field.assignedRole });
    queueIndex += 1;
  }

  // 「やり直す」ボタン等で、直前に確定した署名を取り消してもう一度させる場合
  function redoLastSigner() {
    if (session.signers.length === 0) return;
    redoSignerFrom(session.signers[session.signers.length - 1].fieldId);
  }

  function redoSignerFrom(fieldId) {
    const index = queue.findIndex(field => field.id === fieldId);
    if (index < 0 || !session.signers.some(signer => signer.fieldId === fieldId)) throw new Error('訂正する署名が見つかりません。');
    const removed = session.signers.filter(signer => queue.findIndex(field => field.id === signer.fieldId) >= index);
    removed.forEach(signer => logEvent('signer_redo', { signerId: signer.signerId, fieldId: signer.fieldId }));
    session.signers = session.signers.filter(signer => !removed.includes(signer));
    queueIndex = index;
    session.status = 'in_progress';
    session.completedAt = null;
  }

  function completeSession() {
    if (!isQueueComplete() || !session.signers.length) throw new Error('必要な署名が完了していません。');
    if (session.status === 'completed') return;
    session.status = 'completed';
    session.completedAt = new Date().toISOString();
    logEvent('session_completed');
  }

  function exportState() {
    if (!session) return null;
    return JSON.parse(JSON.stringify({session,template:currentTemplate,queueIds:queue.map(field => field.id),queueIndex,seqCounter}));
  }

  function validateState(state) {
    if (!state || !state.session || !state.template || !Array.isArray(state.queueIds) || !Array.isArray(state.session.signers) || !Array.isArray(state.session.eventLog)) throw new Error('途中の契約データの形式が正しくありません。');
    const errors = Models.validateTemplate(state.template);
    if (errors.length) throw new Error('途中の書式を復元できません。\n' + errors.join('\n'));
    const fields = state.template.pages.flatMap(page => page.fields).filter(field => field.type === 'signature').sort((a,b) => a.signOrder-b.signOrder);
    const expected = state.session.signingMode === 'optional' && !state.session.signingPlan?.includeAdditional ? fields.slice(0,1) : fields;
    if (!fields.length || state.session.signingMode !== (state.template.signingMode || 'legacy') || state.session.templateId !== state.template.id || !Number.isInteger(state.queueIndex) || state.queueIndex < 0 || state.queueIndex > expected.length ||
        state.queueIds.join('|') !== expected.map(field=>field.id).join('|') || !Number.isInteger(state.seqCounter) || state.seqCounter < 0 ||
        state.session.signers.some(signer => !signer || !state.queueIds.slice(0,state.queueIndex).includes(signer.fieldId) || typeof signer.typedName !== 'string' || !signer.typedName.trim() || typeof signer.signatureImageDataUrl !== 'string' || !signer.signatureImageDataUrl.startsWith('data:image/png;base64,'))) throw new Error('途中の契約の署名工程が正しくありません。');
    if (new Set(state.session.signers.map(signer=>signer.fieldId)).size !== state.session.signers.length) throw new Error('途中の署名が重複しています。');
    return expected;
  }

  function restoreState(input) {
    const state = JSON.parse(JSON.stringify(input));
    const fields = validateState(state);
    session = state.session; currentTemplate = state.template; queue = fields;
    queueIndex = state.queueIndex; seqCounter = state.seqCounter;
    logEvent('session_resumed', {reason:'encrypted_draft'});
    return session;
  }

  return {
    startSession, getSession, isQueueComplete, getCurrentField, getProgress, getReusableScribeDetails, getPlannedRole, getPlannedCapacity,
    submitCurrentSigner, skipCurrentField, redoLastSigner, redoSignerFrom, completeSession, exportState, validateState, restoreState,
  };
})();
