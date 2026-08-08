// サイドカー監査JSON(正本記録)の組み立て。ハッシュは最終PDFバイト列(証跡ページ込み)
// から計算したものだけが正しい値になる(PDFに書き込んだ後に計算しないと一致しない)。
const Audit = (() => {
  async function buildAuditRecord(session, finalPdfBytes) {
    const hash = await HashUtils.sha256Hex(finalPdfBytes);
    session.finalPdfHashSha256 = hash;
    return Object.assign({}, session);
  }

  return { buildAuditRecord };
})();
