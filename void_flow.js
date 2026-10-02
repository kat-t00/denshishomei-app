// 無効化・再契約フロー。署名済みPDFは自動保存していないため、
// 無効化したい古いPDFファイルを再アップロードしてもらい、その場でハッシュを再計算して照合する
// (元のPDFのバイト列は一切書き換えない。無効化記録は別ファイルとして出力する)。
const VoidFlow = (() => {
  async function computeFileHash(file) {
    const buffer = await file.arrayBuffer();
    if (new TextDecoder().decode(new Uint8Array(buffer).slice(0, 5)) !== '%PDF-') throw new Error('元の署名済みPDFを選んでください。');
    const hash = await HashUtils.sha256Hex(buffer);
    return { hash, buffer };
  }

  function buildVoidRecord(oldPdfHash, reason, staffName, verificationIdGuess) {
    return {
      format: 'keiyaku-correction',
      schemaVersion: 1,
      recordPurpose: 'correction_or_resigning',
      voidedAt: new Date().toISOString(),
      previousPdfHash: oldPdfHash,
      previousVerificationId: verificationIdGuess || null,
      reason: reason,
      voidedBy: staffName,
    };
  }

  async function buildVoidNoticePdf(voidRecord) {
    const { PDFDocument } = PDFLib;
    const pdfLibDoc = await PDFDocument.create();
    pdfLibDoc.registerFontkit(fontkit);
    const fontBytes = PdfUtils.base64ToArrayBuffer(NOTO_SANS_JP_BASE64);
    const font = await pdfLibDoc.embedFont(fontBytes, { subset: false });
    let page = pdfLibDoc.addPage([595.28, 841.89]);
    const lines = [
      '契約書の訂正・再署名記録',
      '',
      '記録日時（端末時計）: ' + new Date(voidRecord.voidedAt).toLocaleString('ja-JP'),
      '対象契約の検証ID: ' + (voidRecord.previousVerificationId || '(不明・PDFのみで照合)'),
      '対象PDFのSHA-256ハッシュ: ' + voidRecord.previousPdfHash,
      '訂正・再署名の理由: ' + voidRecord.reason,
      '手続き実施者: ' + voidRecord.voidedBy,
      'この記録だけで契約の法的な無効・解除が確定するものではありません。',
      '訂正内容・再署名について相手方と確認し、必要な書類を交付してください。',
    ];
    let y = 780;
    for (const line of lines) {
      let current = '';
      const wrapped = [];
      for (const ch of line) {
        if (current && font.widthOfTextAtSize(current + ch, 11) > 515) { wrapped.push(current); current = ''; }
        current += ch;
      }
      wrapped.push(current);
      for (const text of wrapped) {
        if (y < 40) { page = pdfLibDoc.addPage([595.28, 841.89]); y = 780; }
        page.drawText(text, { x: 40, y, size: 11, font, color: PDFLib.rgb(0.05, 0.05, 0.1) }); y -= 22;
      }
    }
    return pdfLibDoc.save();
  }

  return { computeFileHash, buildVoidRecord, buildVoidNoticePdf };
})();
