// 署名済みPDFを実際に書き出す。pdf-lib + fontkit + Noto Sans JPの組み合わせは
// shinsei_form_app/filler.jsと同じパターン(subset:falseは文字数が多い時に
// 後半のグリフが空白になる既知バグの回避策なので、そのまま踏襲する)。
const PdfWriter = (() => {
  let cachedFontBytes = null;

  function loadFontBytes() {
    if (!cachedFontBytes) {
      cachedFontBytes = PdfUtils.base64ToArrayBuffer(NOTO_SANS_JP_BASE64);
    }
    return cachedFontBytes;
  }

  const TEXT_COLOR = () => PDFLib.rgb(0.05, 0.05, 0.1);

  function fitFontSize(font, text, baseSize, maxWidth) {
    if (!maxWidth) return baseSize;
    const width = font.widthOfTextAtSize(text, baseSize);
    if (width <= maxWidth) return baseSize;
    return Math.max(baseSize * (maxWidth / width), 6);
  }

  // 和暦(令和等)はIntlの日本カレンダーに任せる(改元境界の手計算はミスの元なので避ける)
  function formatDate(date, dateFormat) {
    if (dateFormat === 'reiwa') {
      return new Intl.DateTimeFormat('ja-JP-u-ca-japanese', {
        era: 'long', year: 'numeric', month: 'long', day: 'numeric',
      }).format(date);
    }
    return date.toLocaleDateString('ja-JP');
  }

  function drawFieldText(page, font, field, text) {
    if (!text) return;
    const baseSize = 11;
    const size = fitFontSize(font, text, baseSize, field.width - 4);
    page.drawText(text, {
      x: field.x + 2,
      y: field.y + field.height * 0.25,
      size, font, color: TEXT_COLOR(),
    });
  }

  async function drawSignatureImage(pdfLibDoc, page, field, dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const pngBytes = PdfUtils.base64ToArrayBuffer(base64);
    const pngImage = await pdfLibDoc.embedPng(pngBytes);
    // 署名パッド(canvas)の縦横比は枠の縦横比と一致しないため、枠に強制フィットさせると
    // 手書きの線が潰れたり伸びたりする。縦横比を保ったまま枠に収め(object-fit:contain)、
    // 余った分は中央寄せする。
    const scale = Math.min(field.width / pngImage.width, field.height / pngImage.height);
    const drawWidth = pngImage.width * scale;
    const drawHeight = pngImage.height * scale;
    const x = field.x + (field.width - drawWidth) / 2;
    const y = field.y + (field.height - drawHeight) / 2;
    page.drawImage(pngImage, { x, y, width: drawWidth, height: drawHeight });
  }

  // signerに対応するfieldを探すヘルパー。session.signersはfieldIdを持っている
  function findField(pages, fieldId) {
    for (const page of pages) {
      const f = page.fields.find(f => f.id === fieldId);
      if (f) return f;
    }
    return null;
  }

  // 署名欄と同じ役割の 氏名/住所/続柄/日付/確認チェック欄 を関連項目とみなして値を埋める。
  // 「どちらでも」欄は実際に選ばれた役割(signerRole)で判定する(署名欄自体のassignedRoleは
  // 常に'either'のままなので、そこと比較すると本人/家族固定の関連項目を拾えなくなるため)
  function relatedTextFields(pages, signatureField, signerRole) {
    const results = [];
    pages.forEach(page => {
      page.fields.forEach(f => {
        if (f.id === signatureField.id) return;
        if (f.type !== 'name' && f.type !== 'relationship' && f.type !== 'date' && f.type !== 'address' && f.type !== 'declaration_checkbox') return;
        if (f.assignedRole === signerRole || f.assignedRole === 'either') {
          results.push(f);
        }
      });
    });
    return results;
  }

  const ROLE_LABELS = { recipient: '利用者本人', family: 'ご家族（代理）' };

  const APP_NAME = 'keiyaku_app（介護事業所向け電子契約アプリ）';

  function buildEvidenceText(session) {
    const lines = [];
    lines.push('署名証跡ページ（本ページは電子契約アプリ「' + APP_NAME + '」が自動生成したものです）');
    lines.push('');
    lines.push('検証ID: ' + session.verificationId);
    lines.push('書式バージョン: v' + session.templateVersion + (session.templateVersionLabel ? '（' + session.templateVersionLabel + '）' : ''));
    lines.push('署名開始: ' + new Date(session.startedAt).toLocaleString('ja-JP'));
    lines.push('署名完了: ' + (session.completedAt ? new Date(session.completedAt).toLocaleString('ja-JP') : '-'));
    lines.push('');
    lines.push('■ 署名者一覧');
    session.signers.forEach((s, i) => {
      lines.push((i + 1) + '. ' + (ROLE_LABELS[s.role] || s.role) + '　氏名: ' + s.typedName +
        (s.address ? '　住所: ' + s.address : '') +
        (s.relationship ? '　続柄: ' + s.relationship : '') +
        (s.role === 'family' ? '　代理権限確認: ' + (s.declarationChecked ? '済' : '未') : '') +
        ((s.confirmedDeclarations && s.confirmedDeclarations.length) ? '　確認項目: ' + s.confirmedDeclarations.join('、') : '') +
        '　署名時刻(端末時計): ' + new Date(s.signedAt).toLocaleString('ja-JP'));
    });
    if (session.resignOf) {
      lines.push('');
      lines.push('■ 再契約情報');
      lines.push('本契約は無効化された旧契約の再契約です。');
      lines.push('旧契約の検証ID: ' + session.resignOf.previousVerificationId);
      lines.push('無効化理由: ' + session.resignOf.voidReason);
    }
    if (session.hasExplanationAudio) {
      lines.push('');
      lines.push('■ 重要事項説明の音声記録');
      lines.push('本契約と同時に、説明時の音声記録（同じファイル名で拡張子のみ「_説明音声」+形式）が');
      lines.push('発行されています。そのSHA-256ハッシュ値: ' + session.explanationAudioHashSha256);
    }
    lines.push('');
    lines.push('■ 検証方法');
    lines.push('本PDFが発行後に改ざんされていないかは、本PDFファイルのSHA-256ハッシュ値と、');
    lines.push('本PDFと同時に発行される検証用ファイル（同じファイル名で拡張子のみ「_監査記録.json」）');
    lines.push('に記録されたハッシュ値を照合することで確認できます。両者が一致すれば、');
    lines.push('発行後に本PDFの内容が変更されていないことを意味します。');
    lines.push('');
    lines.push('■ 免責事項');
    lines.push('本記録の時刻は署名を行った端末のシステム時計に基づくものであり、');
    lines.push('第三者機関による認定タイムスタンプではありません。');
    lines.push('IPアドレス等の通信情報は記録していません。');
    lines.push('本アプリは無料配布・無保証のツールです。ご利用は自己責任でお願いします。');
    return lines.join('\n');
  }

  // フォント幅を見ながら1文字ずつ詰めて折り返す(日本語は単語区切りが無いため文字単位で判定する)
  function wrapLineToWidth(font, line, size, maxWidth) {
    if (!line) return [''];
    if (font.widthOfTextAtSize(line, size) <= maxWidth) return [line];
    const result = [];
    let current = '';
    for (const ch of line) {
      const candidate = current + ch;
      if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        result.push(current);
        current = ch;
      } else {
        current = candidate;
      }
    }
    if (current) result.push(current);
    return result;
  }

  // 証跡ページは1ページに収まらない場合、内容を黙って切り捨てず追加ページに続ける
  function appendEvidencePage(pdfLibDoc, font, session) {
    const pageWidth = 595.28, pageHeight = 841.89; // A4
    const size = 10;
    const lineHeight = size * 1.6;
    const marginX = 40;
    const marginBottom = 40;
    const maxWidth = pageWidth - marginX * 2;

    let page = pdfLibDoc.addPage([pageWidth, pageHeight]);
    let y = 800;
    buildEvidenceText(session).split('\n').forEach(line => {
      wrapLineToWidth(font, line, size, maxWidth).forEach(subLine => {
        if (y < marginBottom) {
          page = pdfLibDoc.addPage([pageWidth, pageHeight]);
          y = 800;
        }
        if (subLine) page.drawText(subLine, { x: marginX, y, size, font, color: TEXT_COLOR() });
        y -= lineHeight;
      });
    });
  }

  // 最終的な署名済みPDFのバイト列を作る。証跡ページを付けた後の完成バイト列を返すので、
  // ハッシュ計算は必ずこの関数の戻り値に対して行うこと(証跡ページ追加前のバイト列と一致しない)。
  async function buildSignedPdf(template, session) {
    const { PDFDocument } = PDFLib;
    const bytes = PdfUtils.base64ToArrayBuffer(template.pdfBase64);
    const pdfLibDoc = await PDFDocument.load(bytes);
    pdfLibDoc.registerFontkit(fontkit);
    const fontBytes = loadFontBytes();
    const font = await pdfLibDoc.embedFont(fontBytes, { subset: false });
    const pdfPages = pdfLibDoc.getPages();

    for (const signer of session.signers) {
      const field = findField(template.pages, signer.fieldId);
      if (!field) continue;
      const pageIndex = template.pages.findIndex(p => p.fields.some(f => f.id === field.id));
      const pdfPage = pdfPages[pageIndex];

      await drawSignatureImage(pdfLibDoc, pdfPage, field, signer.signatureImageDataUrl);

      relatedTextFields(template.pages, field, signer.role).forEach(textField => {
        const textPageIndex = template.pages.findIndex(p => p.fields.some(f => f.id === textField.id));
        const textPdfPage = pdfPages[textPageIndex];
        if (textField.type === 'name') drawFieldText(textPdfPage, font, textField, signer.typedName);
        else if (textField.type === 'relationship') drawFieldText(textPdfPage, font, textField, signer.relationship || '');
        else if (textField.type === 'address') drawFieldText(textPdfPage, font, textField, signer.address || '');
        else if (textField.type === 'date') drawFieldText(textPdfPage, font, textField, formatDate(new Date(signer.signedAt), textField.dateFormat));
        else if (textField.type === 'declaration_checkbox') drawFieldText(textPdfPage, font, textField, '✓ 確認済み');
      });
    }

    appendEvidencePage(pdfLibDoc, font, session);
    return pdfLibDoc.save();
  }

  return { buildSignedPdf, buildEvidenceText };
})();
