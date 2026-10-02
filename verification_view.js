// 選択ファイルを端末内だけで照合する。入力値・結果は画面を離れると破棄する。
const VerificationView = (() => {
  let inputs, result, button;
  let revision = 0;
  let busy = false;
  let deliveryInput, deliveryResult;

  function invalidate() {
    revision += 1;
    result.replaceChildren();
    result.removeAttribute('data-status');
    if (deliveryResult) deliveryResult.replaceChildren();
  }

  function reset() {
    if (!inputs) return;
    invalidate();
    inputs.forEach(input => { input.value = ''; });
    if (deliveryInput) deliveryInput.value = '';
  }

  function line(parent, text, className) {
    const p = document.createElement('p');
    p.textContent = text;
    if (className) p.className = className;
    parent.append(p);
  }

  function validateSize(file, label, maxMb) {
    if (!file || !file.size) throw new Error(label + 'を選んでください。空のファイルは照合できません。');
    if (file.size > maxMb * 1024 * 1024) throw new Error(label + 'は、この端末内照合では' + maxMb + 'MBまで対応しています。');
  }

  function renderResult(report, pdfFile, audioFile) {
    result.dataset.status = report.pdf === 'mismatch' || report.audio === 'mismatch' ? 'mismatch'
      : report.audio === 'not_provided' ? 'partial' : 'match';
    const title = document.createElement('h3');
    title.textContent = 'ファイルの照合結果';
    title.tabIndex = -1;
    result.append(title);
    line(result, report.pdf === 'match' ? 'PDF：監査記録のハッシュと一致しました。'
      : 'PDF：監査記録のハッシュと一致しません。', 'verification-outcome');
    line(result, '選択したPDF：' + pdfFile.name);
    const audioMessages = {
      match: '音声：監査記録のハッシュと一致しました。',
      mismatch: '音声：監査記録のハッシュと一致しません。',
      not_provided: '音声：未照合です。この記録には音声があるため、必要なら音声ファイルも選んでください。',
      not_recorded: '音声：この監査記録には音声の記録がありません。',
    };
    line(result, audioMessages[report.audio]);
    if (audioFile) line(result, '選択した音声：' + audioFile.name);
    if (result.dataset.status === 'mismatch') {
      line(result, 'ファイルの組み合わせや、保存後に編集・再出力していないかをご確認ください。不一致だけで、変更の理由は判断できません。');
    }
    line(result, '一致は、選択したファイルとJSONに記載されたハッシュの一致を示します。本人性・契約の有効性・JSONの記載内容の正しさは確認していません。PDFとJSONを両方書き換えてハッシュを再計算した場合、この方法だけでは変更を検出できません。');
    const summary = document.createElement('details');
    const summaryTitle = document.createElement('summary');
    summaryTitle.textContent = '監査記録の記載内容と照合値（記載内容の正しさは未検証）';
    summary.append(summaryTitle);
    line(summary, '記録形式：' + (report.legacy ? '従来形式' : 'keiyaku-audit v1'));
    line(summary, '検証ID：' + report.summary.verificationId);
    line(summary, '利用者氏名：' + (report.summary.recipientName || '記載なし'));
    line(summary, '書式名：' + (report.summary.templateName || '記載なし'));
    line(summary, '署名完了日時（端末時計による記録）：' + report.summary.completedAt);
    line(summary, '選択したPDFのSHA-256：' + report.computedPdfHash, 'verification-hash');
    line(summary, 'JSONに記載されたSHA-256：' + report.recordedPdfHash, 'verification-hash');
    result.append(summary);
    title.focus();
  }

  async function verify() {
    if (busy) return;
    invalidate();
    const requestRevision = revision;
    const [pdfFile, auditFile, audioFile] = inputs.map(input => input.files[0]);
    busy = true;
    button.disabled = true;
    button.textContent = '照合中…';
    try {
      validateSize(pdfFile, '署名済みPDF', 50);
      validateSize(auditFile, '監査記録JSON', 20);
      if (audioFile) validateSize(audioFile, '説明音声', 100);
      const auditText = await auditFile.text();
      const pdfBytes = await pdfFile.arrayBuffer();
      const audioBytes = audioFile ? await audioFile.arrayBuffer() : null;
      const report = await Audit.verifyFiles(pdfBytes, auditText, audioBytes);
      if (requestRevision !== revision) return;
      renderResult(report, pdfFile, audioFile);
    } catch (e) {
      if (requestRevision !== revision) return;
      result.dataset.status = 'mismatch';
      line(result, '照合できませんでした。' + e.message);
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = 'ファイルを照合する';
    }
  }

  async function readDelivery() {
    deliveryResult.replaceChildren(); const requestRevision = ++revision;
    const button = document.getElementById('btn-read-delivery'); button.disabled = true;
    try {
      const file = deliveryInput.files[0]; validateSize(file,'交付記録JSON',2);
      const record = Audit.parseDeliveryRecord(await file.text());
      const pdf = inputs[0].files[0];
      let pdfResult = 'PDFとの対応：未照合（上でPDFを選択してください）';
      if (pdf) {
        validateSize(pdf,'署名済みPDF',50);
        const hash = await HashUtils.sha256Hex(await pdf.arrayBuffer());
        pdfResult = hash === record.finalPdfHashSha256.toLowerCase() ? 'PDFとの対応：ハッシュが一致しました' : 'PDFとの対応：ハッシュが一致しません';
      }
      if (requestRevision !== revision) return;
      line(deliveryResult,pdfResult,'verification-outcome');
      line(deliveryResult,'交付結果：' + (record.status === 'delivered' ? '控えを渡した' : 'まだ渡していない'));
      line(deliveryResult,'相手：' + (record.recipient || '未記入'));
      line(deliveryResult,'方法：' + (record.method === 'paper' ? '紙' : '電子ファイル'));
      line(deliveryResult,'詳細：' + (record.detail || '未記入'));
      line(deliveryResult,'記録日時（端末時計）：' + new Date(record.recordedAt).toLocaleString('ja-JP'));
      line(deliveryResult,'事業所・記録担当者：' + record.operator.providerName + ' / ' + record.operator.staffName);
      line(deliveryResult,'検証ID：' + record.verificationId);
      line(deliveryResult,'これは事業者が入力した交付記録です。実際の受領や内容の真正性を認証するものではありません。');
    } catch(e) { if (requestRevision === revision) line(deliveryResult,'交付記録を表示できませんでした。' + e.message); }
    finally { button.disabled = false; }
  }

  function init() {
    inputs = ['verify-pdf-input', 'verify-audit-input', 'verify-audio-input'].map(id => document.getElementById(id));
    result = document.getElementById('verification-result');
    button = document.getElementById('btn-verify-files');
    deliveryInput = document.getElementById('verify-delivery-input'); deliveryResult = document.getElementById('delivery-record-result');
    deliveryInput.addEventListener('change',invalidate);
    document.getElementById('btn-read-delivery').addEventListener('click',readDelivery);
    inputs.forEach(input => input.addEventListener('change', invalidate));
    button.addEventListener('click', verify);
    document.getElementById('btn-clear-verification').addEventListener('click', reset);
    document.getElementById('btn-clear-verification-audio').addEventListener('click', () => {
      inputs[2].value = '';
      invalidate();
    });
  }

  return { init, reset };
})();
