// 無効化・再契約フロー。署名済みPDFは自動保存していないため、
// 無効化したい古いPDFファイルを再アップロードしてもらい、その場でハッシュを再計算して照合する
// (元のPDFのバイト列は一切書き換えない。無効化記録は別ファイルとして出力する)。
const VoidFlow = (() => {
  async function computeFileHash(file) {
    const buffer = await file.arrayBuffer();
    const hash = await HashUtils.sha256Hex(buffer);
    return { hash, buffer };
  }

  function buildVoidRecord(oldPdfHash, reason, staffName, verificationIdGuess) {
    return {
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
    const page = pdfLibDoc.addPage([595.28, 841.89]);
    const lines = [
      '契約無効化通知',
      '',
      '無効化日時: ' + new Date(voidRecord.voidedAt).toLocaleString('ja-JP'),
      '対象契約の検証ID: ' + (voidRecord.previousVerificationId || '(不明・PDFのみで照合)'),
      '対象PDFのSHA-256ハッシュ: ' + voidRecord.previousPdfHash,
      '無効化理由: ' + voidRecord.reason,
      '手続き実施者: ' + voidRecord.voidedBy,
    ];
    let y = 780;
    lines.forEach(line => {
      page.drawText(line, { x: 40, y, size: 11, font, color: PDFLib.rgb(0.05, 0.05, 0.1) });
      y -= 22;
    });
    return pdfLibDoc.save();
  }

  return { computeFileHash, buildVoidRecord, buildVoidNoticePdf };
})();
