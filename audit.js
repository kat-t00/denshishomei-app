// サイドカー監査JSON(照合用の補助記録)の組み立て。ハッシュは最終PDFバイト列(証跡ページ込み)
// から計算したものだけが正しい値になる(PDFに書き込んだ後に計算しないと一致しない)。
const Audit = (() => {
  const FORMAT = 'keiyaku-audit';
  const SCHEMA_VERSION = 1;
  const HASH_PATTERN = /^[a-f0-9]{64}$/i;

  function selectFields(source, names) {
    const selected = {};
    names.forEach(name => {
      if (source && source[name] !== undefined) selected[name] = source[name];
    });
    return selected;
  }

  async function buildAuditRecord(session, finalPdfBytes, templateName) {
    const hash = await HashUtils.sha256Hex(finalPdfBytes);
    session.finalPdfHashSha256 = hash;
    // セッション丸ごとの出力は避ける。住所・署名画像はPDFに残し、JSONには重複させない。
    const record = Object.assign({
      format: FORMAT, schemaVersion: SCHEMA_VERSION,
      recordOrigin: 'local_browser', timeSource: 'device_clock', templateName: templateName || '',
    }, selectFields(session, [
      'sessionId', 'verificationId', 'templateId', 'templateFamilyId', 'templateVersion', 'templateVersionLabel',
      'startedAt', 'completedAt', 'status', 'recipientName', 'signingMode', 'finalPdfHashSha256',
      'hasExplanationAudio', 'explanationAudioHashSha256',
    ]));
    record.operator = session.operator ? selectFields(session.operator, ['providerName','staffName']) : null;
    record.deliveryPlan = session.deliveryPlan ? selectFields(session.deliveryPlan, ['method','electronicConsent']) : null;
    record.signingPlan = session.signingPlan
      ? selectFields(session.signingPlan, ['primaryRole', 'primaryCapacity', 'includeAdditional']) : null;
    record.signers = session.signers.map(signer => selectFields(signer, [
      'signerId', 'role', 'order', 'fieldId', 'typedName', 'relationship', 'signingCapacity',
      'recipientConsentConfirmed', 'authorityBasis', 'declarationChecked', 'confirmedDeclarations', 'confirmedDeclarationIds', 'signedAt', 'deliveryMethod',
    ]));
    // やり直した署名者も追跡できるよう、イベントの氏名・確認事項は残す。
    record.eventLog = (session.eventLog || []).map(event => selectFields(event, [
      'seq', 'at', 'type', 'signerId', 'role', 'signingCapacity', 'typedName', 'recipientConsentConfirmed',
      'authorityBasis', 'fieldId', 'assignedRole', 'reason',
    ]));
    record.resignOf = session.resignOf
      ? selectFields(session.resignOf, ['previousPdfHash', 'previousVerificationId', 'voidReason']) : null;
    // 保存後にセッションを書き換えても、作成済みの監査記録には影響させない。
    return JSON.parse(JSON.stringify(record));
  }

  function parseRecord(text) {
    let record;
    try { record = JSON.parse(text); }
    catch (_) { throw new Error('監査記録を読み取れません。元のJSONファイルを選び直してください。'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('このファイルは監査記録ではありません。');
    }
    const legacy = record.format === undefined && record.schemaVersion === undefined;
    if (!legacy && (record.format !== FORMAT || record.schemaVersion !== SCHEMA_VERSION)) {
      throw new Error('この監査記録の形式・バージョンには対応していません。作成元のアプリをご確認ください。');
    }
    const hasText = value => typeof value === 'string' && value.trim().length > 0;
    if (!hasText(record.sessionId) || !hasText(record.verificationId) || record.status !== 'completed' ||
        !hasText(record.completedAt) || !Number.isFinite(Date.parse(record.completedAt)) ||
        !Array.isArray(record.signers) || !record.signers.length ||
        record.signers.some(signer => !signer || !hasText(signer.typedName)) ||
        typeof record.finalPdfHashSha256 !== 'string' || !HASH_PATTERN.test(record.finalPdfHashSha256)) {
      throw new Error('署名完了時の監査記録に必要な情報がありません。テンプレートのバックアップや無効化記録とは別のファイルです。');
    }
    if (typeof record.hasExplanationAudio !== 'boolean' ||
        (record.hasExplanationAudio && (typeof record.explanationAudioHashSha256 !== 'string' || !HASH_PATTERN.test(record.explanationAudioHashSha256)))) {
      throw new Error('監査記録の音声情報が不正です。元のJSONファイルを選び直してください。');
    }
    return { record, legacy };
  }

  // 照合対象は選択ファイルのバイト列とJSONのハッシュのみ。JSON自体の真正性は検証しない。
  async function verifyFiles(pdfBytes, auditText, audioBytes) {
    const { record, legacy } = parseRecord(auditText);
    const bytes = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
    if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) {
      throw new Error('署名済みPDFファイルを選んでください。');
    }
    if (audioBytes != null && !record.hasExplanationAudio) {
      throw new Error('この監査記録には音声のハッシュがありません。音声の選択を解除してください。');
    }
    const computedPdfHash = await HashUtils.sha256Hex(bytes);
    let audio = record.hasExplanationAudio ? 'not_provided' : 'not_recorded';
    if (audioBytes != null) {
      audio = (await HashUtils.sha256Hex(audioBytes)) === record.explanationAudioHashSha256.toLowerCase() ? 'match' : 'mismatch';
    }
    return {
      pdf: computedPdfHash === record.finalPdfHashSha256.toLowerCase() ? 'match' : 'mismatch',
      audio, legacy, computedPdfHash, recordedPdfHash: record.finalPdfHashSha256.toLowerCase(),
      // 旧JSONに含まれる画像等は画面側に渡さない。
      summary: selectFields(record, ['verificationId', 'recipientName', 'templateName', 'completedAt']),
    };
  }

  function parseDeliveryRecord(text) {
    let record; try { record = JSON.parse(text); } catch (_) { throw new Error('交付記録JSONを読み取れません。'); }
    if (!record || record.format !== 'keiyaku-delivery' || record.schemaVersion !== 1 ||
        !HASH_PATTERN.test(record.finalPdfHashSha256 || '') || !['paper','electronic'].includes(record.method) ||
        !['pending','delivered'].includes(record.status) || typeof record.verificationId !== 'string' ||
        typeof record.recipient !== 'string' || typeof record.detail !== 'string' ||
        typeof record.recordedAt !== 'string' || Number.isNaN(Date.parse(record.recordedAt)) ||
        !record.operator || typeof record.operator.providerName !== 'string' || typeof record.operator.staffName !== 'string') throw new Error('交付記録の形式が正しくありません。監査記録とは別のファイルです。');
    return { ...selectFields(record,['verificationId','finalPdfHashSha256','recordedAt','method','recipient','status','detail']),
      electronicConsent:record.electronicConsent === true,operator:selectFields(record.operator,['providerName','staffName']) };
  }

  return { buildAuditRecord, verifyFiles, parseDeliveryRecord };
})();
