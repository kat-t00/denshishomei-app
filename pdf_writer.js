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

  // 和暦(令和等)はIntlの日本カレンダーに任せる(改元境界の手計算はミスの元なので避ける)
  function formatDate(date, dateFormat) {
    if (dateFormat === 'reiwa') {
      return new Intl.DateTimeFormat('ja-JP-u-ca-japanese', {
        era: 'long', year: 'numeric', month: 'long', day: 'numeric',
      }).format(date);
    }
    if (dateFormat === 'gregorian_kanji') {
      // 西暦のまま「2026年9月1日」のように年月日を漢字区切りにする(スラッシュ表記は
      // 契約書として事務的すぎるという声への対応。元号は使わないので改元の影響を受けない)
      return new Intl.DateTimeFormat('ja-JP', {
        year: 'numeric', month: 'long', day: 'numeric',
      }).format(date);
    }
    return date.toLocaleDateString('ja-JP');
  }

  function drawFieldText(page, font, field, text) {
    if (!text) return;
    const baseSize = field.fontSize || 11;
    const width = field.width - 4, height = field.height - 4;
    // 住所は複数行を使う。文字を省略せず、幅と高さの両方に収まるサイズを探す。
    for (let size = baseSize; size >= 6; size = Math.max(5.5, size - 0.5)) {
      const lines = field.type === 'address' || field.type === 'recipient_address'
        ? String(text).split(/\r?\n/).flatMap(line => wrapLineToWidth(font, line, size, width))
        : [String(text).replace(/\r?\n/g, ' ')];
      const glyphHeight = font.heightAtSize(size);
      const ascent = font.heightAtSize(size, { descender: false });
      const lineHeight = Math.max(glyphHeight, size * 1.3);
      const totalHeight = glyphHeight + (lines.length - 1) * lineHeight;
      if (totalHeight > height || lines.some(line => font.widthOfTextAtSize(line, size) > width)) continue;
      const top = field.y + field.height - 2 - (height - totalHeight) / 2;
      lines.forEach((line, index) => page.drawText(line, {
        x: field.x + 2, y: top - ascent - index * lineHeight,
        size, font, color: TEXT_COLOR(),
      }));
      return;
    }
    const labels = { name: '署名者氏名欄', address: '署名者住所欄', recipient_address: '利用者住所欄', date: '日付欄', relationship: '続柄欄', declaration_checkbox: '確認チェック欄' };
    throw new Error('「' + (field.label || labels[field.type] || field.type) + '」の文字が枠に収まりません。文字を省略せず出力するため、テンプレートの枠を広げてください。');
  }

  async function drawSignatureImage(pdfLibDoc, page, field, dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const pngBytes = PdfUtils.base64ToArrayBuffer(base64);
    const pngImage = await pdfLibDoc.embedPng(pngBytes);
    // 署名パッド(canvas)の縦横比は枠の縦横比と一致しないため、枠に強制フィットさせると
    // 手書きの線が潰れたり伸びたりする。縦横比を保ったまま枠に収め(object-fit:contain)、
    // 余った分は中央寄せする。
    // 実際の署名(特に高齢者)は枠いっぱいに書かれるとは限らず、上記のcontain後もなお
    // 小さく見えることがあるため、テンプレート作成時に指定した表示サイズ(%)をさらに掛ける。
    // 100%を超えると枠を意図的にはみ出して大きく表示する(中央寄せなので見た目は崩れない)
    const sizePercent = field.signatureScale || 100;
    const scale = Math.min(field.width / pngImage.width, field.height / pngImage.height) * (sizePercent / 100);
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

  // signatureFieldに明示的に紐付いた(linkedFieldId一致) 氏名/住所/続柄/日付/確認チェック欄 を
  // 関連項目とみなして値を埋める。以前は役割(本人/家族)だけでマッチングしていたが、
  // 署名欄が複数あるテンプレートで「本人欄の下に家族の住所が印字される」等の事故が
  // 実際にあったため、「どの署名欄の項目か」を明示的に紐付ける方式に変更した。
  // 表示・必須チェックと同じ役割判定で、印字対象を選ぶ。
  function relatedTextFields(template, signatureField, signerRole) {
    return Models.getSignerFields(template, signatureField.id, signerRole,
      ['name','relationship','date','address','declaration_checkbox']);
  }

  const ROLE_LABELS = { recipient: '利用者本人', family: 'ご家族', additional: '追加の署名者' };
  const CAPACITY_LABELS = { self: '本人自署', scribe: '本人の意思確認済みの代筆', representative: '代理人署名', additional: '追加署名者本人' };

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
    if (session.operator) {
      lines.push('事業所: ' + session.operator.providerName);
      lines.push('説明・確認担当者（事業者の申告）: ' + session.operator.staffName);
    }
    if (session.deliveryPlan) lines.push('控えの交付予定: ' + (session.deliveryPlan.method === 'electronic' ? '電子（受取人の承諾確認済み）' : '紙') + ' / 実施結果は別の交付記録に記載');
    lines.push('■ 署名者一覧');
    if (session.recipientName) lines.push('利用者氏名: ' + session.recipientName);
    if (session.recipientAddress) lines.push('利用者住所: ' + Models.fullAddress(session.recipientAddress,session.recipientBuilding).replace(/\n/g,' '));
    if ((session.eventLog || []).some(event => event.reason === 'additional_not_required')) {
      lines.push('追加署名: 署名前の確認で今回は不要と選択');
    }
    session.signers.forEach((s, i) => {
      lines.push((i + 1) + '. 実際に記入した人: ' + (ROLE_LABELS[s.role] || s.role) + '　氏名: ' + s.typedName +
        '　記入方法: ' + (CAPACITY_LABELS[s.signingCapacity] || (s.role === 'family' ? '代理人署名（従来の記録）' : CAPACITY_LABELS[s.role] || s.role)) +
        (s.address ? '　住所: ' + Models.fullAddress(s.address,s.building).replace(/\n/g,' ') : '') +
        (s.relationship ? '　続柄: ' + s.relationship : '') +
        (s.signingCapacity === 'representative' || (s.role === 'family' && !s.signingCapacity) ? '　代理権確認: ' + (s.declarationChecked ? '済' : '未') + (s.authorityBasis ? '（根拠: ' + s.authorityBasis + '）' : '') : '') +
        (s.signingCapacity === 'scribe' ? '　本人の意思確認: ' + (s.recipientConsentConfirmed ? '済' : '未') : '') +
        ((s.confirmedDeclarations && s.confirmedDeclarations.length) ? '　確認項目: ' + s.confirmedDeclarations.join('、') : '') +
        '　署名時刻(端末時計): ' + new Date(s.signedAt).toLocaleString('ja-JP'));
    });
    if (session.resignOf) {
      lines.push('');
      lines.push('■ 再契約情報');
      lines.push('本書面は旧契約書の訂正・再署名に関連する記録です。');
      lines.push('旧契約の検証ID: ' + session.resignOf.previousVerificationId);
      lines.push('訂正・再署名の理由: ' + session.resignOf.voidReason);
    }
    if (session.hasExplanationAudio) {
      lines.push('');
      lines.push('■ 重要事項説明の音声記録');
      lines.push('本契約と同時に、説明時の音声記録（同じファイル名で拡張子のみ「_説明音声」+形式）が');
      lines.push('発行されています。そのSHA-256ハッシュ値: ' + session.explanationAudioHashSha256);
    }
    lines.push('');
    lines.push('■ 検証方法');
    lines.push('アプリのホームにある「保存した書類を照合」でPDFと監査記録を選択できます。');
    lines.push('本PDFと保存済み監査記録の対応関係は、本PDFファイルのSHA-256ハッシュ値と、');
    lines.push('本PDFと同時に発行される監査記録（ファイル名の末尾が「_監査記録.json」）');
    lines.push('に記録されたハッシュ値を照合することで確認できます。');
    lines.push('ただし、PDFと監査記録の両方を変更してハッシュを再計算した場合、');
    lines.push('この照合だけでは変更を検出できません。元の監査記録の保全が必要です。');
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
  async function buildSignedPdf(template, session, options = {}) {
    const errors = Models.validateTemplate(template);
    if (errors.length) throw new Error(errors.join('\n'));
    const { PDFDocument } = PDFLib;
    const bytes = PdfUtils.base64ToArrayBuffer(template.pdfBase64);
    const pdfLibDoc = await PDFDocument.load(bytes);
    pdfLibDoc.registerFontkit(fontkit);
    const fontBytes = loadFontBytes();
    const font = await pdfLibDoc.embedFont(fontBytes, { subset: false });
    const pdfPages = pdfLibDoc.getPages();
    pdfPages.forEach((page, index) => {
      const crop = page.getCropBox();
      if (page.getRotation().angle % 360 !== 0 || crop.x !== 0 || crop.y !== 0) {
        throw new Error((index + 1) + 'ページ目に回転または特殊な切り抜き情報があります。配置がずれるため、回転・切り抜き情報のないPDFを使用してください。');
      }
    });

    template.pages.forEach((page, index) => page.fields.forEach(field => {
      if (field.type === 'recipient_name') drawFieldText(pdfPages[index], font, field, session.recipientName);
      else if (field.type === 'recipient_address') drawFieldText(pdfPages[index], font, field, Models.fullAddress(session.recipientAddress,session.recipientBuilding));
    }));
    for (const signer of session.signers) {
      const field = findField(template.pages, signer.fieldId);
      if (!field) continue;
      const pageIndex = template.pages.findIndex(p => p.fields.some(f => f.id === field.id));
      const pdfPage = pdfPages[pageIndex];

      await drawSignatureImage(pdfLibDoc, pdfPage, field, signer.signatureImageDataUrl);

      relatedTextFields(template, field, signer.role).forEach(textField => {
        const textPageIndex = template.pages.findIndex(p => p.fields.some(f => f.id === textField.id));
        const textPdfPage = pdfPages[textPageIndex];
        if (textField.type === 'name') drawFieldText(textPdfPage, font, textField, signer.typedName);
        else if (textField.type === 'relationship') drawFieldText(textPdfPage, font, textField, signer.relationship || '');
        else if (textField.type === 'address') drawFieldText(textPdfPage, font, textField, Models.fullAddress(signer.address,signer.building));
        else if (textField.type === 'date') drawFieldText(textPdfPage, font, textField, formatDate(new Date(signer.signedAt), textField.dateFormat));
        else if (textField.type === 'declaration_checkbox' && (options && options.preview || (signer.confirmedDeclarationIds || []).includes(textField.id) || (!signer.confirmedDeclarationIds && (signer.confirmedDeclarations || []).includes(textField.label)))) drawFieldText(textPdfPage, font, textField, textField.checkPrintStyle === 'check' ? '✓' : '✓ 確認済み');
      });
    }

    appendEvidencePage(pdfLibDoc, font, session);
    if (options.preview) {
      pdfLibDoc.getPages().forEach(page => page.drawText('見本・契約には使用できません', {
        x: 20, y: 20, font, size: 14, color: PDFLib.rgb(0.8, 0.1, 0.1),
      }));
    }
    return pdfLibDoc.save();
  }

  return { buildSignedPdf, buildEvidenceText };
})();
