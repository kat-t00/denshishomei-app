// PDFの表示と、その上への署名欄ドラッグ配置を担当する。
// PDFの描画は2D canvas(pdf.js)、操作可能な項目はその上に重ねたdiv要素(overlay)で作る。
// ドラッグ・リサイズはPointer Events(pointerdown/pointermove/pointerup)を使う。
// マウスに加えて指・Apple Pencil・タッチペンでも同じコードで動くようにするため。
const FieldEditor = (() => {
  let canvasEl = null;
  let overlayEl = null;
  let zoomLabelEl = null;
  let pdfDoc = null; // pdf.jsのドキュメント(表示専用。書き込みはpdf_writer.js側でpdf-libを使い別途読み込む)
  let pages = []; // [{ widthPt, heightPt, fields: [] }]
  let currentPageIndex = 0;
  let zoom = null;
  let armedFieldType = null;
  let activeSignatureId = null;
  let onFieldSelected = null; // (field) => void
  let onPagesChanged = null; // () => void  (フィールドの追加・移動・削除の度に呼ぶ)

  const signaturePreviews = new Map();
  let signatureSample = null;
  function getSignatureSample() {
    if (signatureSample) return signatureSample;
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 60;
    const context = canvas.getContext('2d'); context.strokeStyle = '#25364a'; context.lineWidth = 3; context.lineCap = 'round';
    context.stroke(new Path2D('M10 42 Q25 3 35 20 T52 40 Q66 12 72 36 L85 23 M99 13 L90 47 L117 26 L104 45 M139 9 Q126 48 147 39 L171 17 L158 48 Q184 21 187 36 T225 28'));
    signatureSample = canvas.toDataURL(); return signatureSample;
  }
  let showPrintPreview = true;
  function setSignaturePreview(id, image) { signaturePreviews.set(id, image); renderFieldBoxes(); }
  function getSignaturePreview(id) { return signaturePreviews.get(id); }
  function setPrintPreviewVisible(visible) { showPrintPreview = visible; renderFieldBoxes(); }

  function init(opts) {
    canvasEl = opts.canvasEl;
    overlayEl = opts.overlayEl;
    zoomLabelEl = opts.zoomLabelEl || null;
    onFieldSelected = opts.onFieldSelected || null;
    onPagesChanged = opts.onPagesChanged || null;
    zoom = PdfUtils.createZoomControl();
  }

  async function loadPdfBytes(arrayBuffer) {
    pdfDoc = await PdfUtils.loadPdf(arrayBuffer);
    pages = [];
    signaturePreviews.clear();
    activeSignatureId = null;
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const size = await PdfUtils.getPageSize(pdfDoc, i);
      pages.push({ widthPt: size.widthPt, heightPt: size.heightPt, fields: [] });
    }
    currentPageIndex = 0;
    await renderCurrentPage();
  }

  // 既存テンプレートを編集する時: PDFバイト列とfields定義の両方を復元する
  async function loadFromTemplate(template) {
    const bytes = PdfUtils.base64ToArrayBuffer(template.pdfBase64);
    pdfDoc = await PdfUtils.loadPdf(bytes);
    pages = template.pages.map(p => ({
      widthPt: p.widthPt,
      heightPt: p.heightPt,
      fields: p.fields.slice(),
    }));
    signaturePreviews.clear();
    activeSignatureId = null;
    normalizeSignatureOrder();
    currentPageIndex = 0;
    await renderCurrentPage();
  }

  async function renderCurrentPage() {
    const page = pages[currentPageIndex];
    zoom.setPageSize(page.widthPt, page.heightPt);
    await PdfUtils.renderPageToCanvas(pdfDoc, currentPageIndex + 1, canvasEl, zoom.getScale());
    overlayEl.style.width = canvasEl.width + 'px';
    overlayEl.style.height = canvasEl.height + 'px';
    renderFieldBoxes();
    updateZoomLabel();
  }

  function updateZoomLabel() {
    if (zoomLabelEl) zoomLabelEl.textContent = zoom.getLabel();
  }

  async function zoomIn() { zoom.zoomIn(); await renderCurrentPage(); }
  async function zoomOut() { zoom.zoomOut(); await renderCurrentPage(); }
  async function fitToView(wrapEl) { zoom.fitToView(wrapEl); await renderCurrentPage(); }

  async function goToPage(index) {
    if (index < 0 || index >= pages.length) return;
    currentPageIndex = index;
    await renderCurrentPage();
  }

  function getPageCount() { return pages.length; }
  function getCurrentPageIndex() { return currentPageIndex; }
  function getPages() { return pages; }

  // テンプレート全体(全ページ)の署名欄を、署名する順番で並べて返す。
  // 氏名欄・住所欄などの付随項目を「どの署名欄の項目か」に紐付けるための一覧として使う
  function getSignatureFields() {
    const result = [];
    pages.forEach(page => {
      page.fields.forEach(f => {
        if (f.type === 'signature') result.push(f);
      });
    });
    return result.sort((a, b) => a.signOrder - b.signOrder);
  }

  function setArmedFieldType(type) {
    armedFieldType = type;
  }

  function getActiveSignatureField() {
    const signatures = getSignatureFields();
    return signatures.find(field => field.id === activeSignatureId) || (signatures.length === 1 ? signatures[0] : null);
  }
  function setActiveSignatureForField(field) {
    if (!field) return;
    if (field.type === 'signature') activeSignatureId = field.id;
    else if (!['recipient_name','recipient_address'].includes(field.type) && field.linkedFieldId) {
      if (getSignatureFields().some(signature => signature.id === field.linkedFieldId)) activeSignatureId = field.linkedFieldId;
    }
  }

  function fitAddressRows(field) {
    if (!['address','recipient_address'].includes(field.type) || !field.addressRows) return;
    const page = pages.find(page => page.fields.some(item => item.id === field.id));
    if (!page) return;
    const height = (field.fontSize || 14) * 1.5 * field.addressRows + 4;
    const top = field.y + field.height;
    field.height = Math.min(height, page.heightPt);
    field.y = Math.max(0, Math.min(top - field.height, page.heightPt - field.height));
  }

  function normalizeSignatureOrder() {
    getSignatureFields().forEach((field, index) => { field.signOrder = index + 1; });
  }
  function setSignatureOrder(field, position) {
    const ordered = getSignatureFields().filter(item => item.id !== field.id);
    ordered.splice(Math.max(0, Math.min(ordered.length, position - 1)), 0, field);
    ordered.forEach((item, index) => { item.signOrder = index + 1; });
    renderFieldBoxes();
  }

  const FIELD_TYPE_LABELS = {
    signature: '署名欄',
    date: '日付欄',
    name: '署名者氏名欄',
    recipient_name: '利用者氏名欄',
    recipient_address: '利用者住所欄',
    relationship: '続柄欄',
    declaration_checkbox: '確認チェック欄',
    address: '住所欄',
  };

  const PRINT_PREVIEW_TEXT = {
    name: '山田 太郎', recipient_name: '山田 太郎',
    recipient_address: '東京都千代田区丸の内一丁目2番3号\n見本マンション101号室',
    address: '東京都千代田区丸の内一丁目2番3号\n見本マンション101号室',
    relationship: '長女', date: '2026年9月23日', declaration_checkbox: '✓ 確認済み',
  };

  function getPrintPreviewText(field) {
    if (field.type === 'declaration_checkbox' && field.checkPrintStyle === 'check') return '✓';
    if (field.type !== 'date') return PRINT_PREVIEW_TEXT[field.type] || '印字見本';
    if (field.dateFormat === 'reiwa') return '令和8年9月23日';
    if (field.dateFormat === 'gregorian_kanji') return '2026年9月23日';
    return '2026/9/23';
  }

  // 「本人の住所欄と家族の住所欄、両方とも同じデータで上書きされて重なる」という事故が
  // 実際にあった。役割(本人/家族)だけでのマッチングだと、署名欄が複数ある時に
  // どの署名欄の付随項目かが区別できないのが原因だったため、「どの署名欄に属するか」で
  // 紐付ける方式に変更。枠の色とラベルで常に見える化する(field-group-*はstyle.css側)。
  const GROUP_COLOR_CLASSES = ['field-group-1', 'field-group-2', 'field-group-3'];

  function groupColorClass(index) {
    return GROUP_COLOR_CLASSES[index] || 'field-group-other';
  }

  function groupLabel(signatureField, index) {
    return signatureField.label || (index + 1) + '人目の署名欄';
  }

  function renderFieldBoxes() {
    overlayEl.innerHTML = '';
    const page = pages[currentPageIndex];
    const heightPt = page.heightPt;
    const signatureFields = getSignatureFields();

    page.fields.forEach(field => {
      const box = document.createElement('div');
      // 署名欄自体はどの署名欄グループにも属さない(グループの起点そのものなので)。
      // 氏名欄・住所欄などの付随項目だけ、紐付いた署名欄グループの色を付ける
      const isSignature = field.type === 'signature';
      let groupClass = '';
      let groupText = '';
      if (!isSignature && !['recipient_name','recipient_address'].includes(field.type)) {
        const groupIndex = signatureFields.findIndex(sf => sf.id === field.linkedFieldId);
        if (groupIndex >= 0) {
          groupClass = ' ' + groupColorClass(groupIndex);
          groupText = groupLabel(signatureFields[groupIndex], groupIndex);
        } else {
          // 署名欄が2つ以上あるのにどれにも紐付いていない = 設定漏れ。目立つ警告色にする
          groupClass = ' field-group-unlinked';
          groupText = '⚠️ 署名欄未設定';
        }
      }
      box.className = 'field-box field-type-' + field.type + groupClass;
      box.dataset.fieldId = field.id;
      const rect = PdfUtils.pdfRectToPixel(field, heightPt, zoom.getScale());
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';

      const labelSpan = document.createElement('span');
      labelSpan.className = 'field-box-label';
      labelSpan.textContent = (isSignature ? '署名欄 ' + field.signOrder + (field.label ? '：' + field.label : '') : field.label || FIELD_TYPE_LABELS[field.type] || field.type) +
        (groupText ? '（' + groupText + '）' : '');
      box.appendChild(labelSpan);

      if (isSignature && showPrintPreview) {
        const image = document.createElement('img'); image.className = 'field-signature-preview';
        image.alt = signaturePreviews.has(field.id) ? '試し書きした署名' : '手書き署名の見本';
        image.src = signaturePreviews.get(field.id) || getSignatureSample();
        image.style.transform = 'scale(' + (field.signatureScale || 100) / 100 + ')';
        box.appendChild(image); labelSpan.textContent += signaturePreviews.has(field.id) ? '｜試し書き' : '｜手書き見本';
      }
      if (!isSignature && showPrintPreview) {
        const printPreview = document.createElement('span');
        printPreview.className = 'field-box-print-preview';
        labelSpan.textContent += '｜印字見本';
        printPreview.textContent = getPrintPreviewText(field);
        printPreview.style.fontSize = Math.max(8, (field.fontSize || 11) * zoom.getScale()) + 'px';
        if (field.type === 'address' || field.type === 'recipient_address') printPreview.classList.add('is-multiline');
        box.appendChild(printPreview);
      }

      attachMoveHandlers(box, field, page);
      ['nw', 'ne', 'sw', 'se'].forEach(corner => {
        const handle = document.createElement('div');
        handle.className = 'field-resize-handle field-resize-' + corner;
        attachResizeHandlers(handle, box, field, page, corner);
        box.appendChild(handle);
      });

      box.addEventListener('pointerdown', (evt) => {
        if (evt.target.classList.contains('field-resize-handle')) return;
        selectField(field);
      });

      overlayEl.appendChild(box);
      const printPreview = box.querySelector('.field-box-print-preview');
      if (printPreview) {
        const baseSize = field.fontSize || 11;
        let fittedSize = baseSize;
        const scale = zoom.getScale();
        const overflows = () => printPreview.scrollWidth > printPreview.clientWidth + 2 || printPreview.scrollHeight > printPreview.clientHeight + 2;
        while (overflows() && fittedSize > 6) {
          fittedSize = Math.max(6, fittedSize - 0.5);
          printPreview.style.fontSize = Math.max(8, fittedSize * scale) + 'px';
        }
        if (overflows()) {
          printPreview.classList.add('is-overflowing');
          printPreview.title = '6ptでも見本が枠に収まりません。枠を広げるか、PDFの試し印字をご確認ください。';
        } else {
          printPreview.title = fittedSize < baseSize
            ? '設定値 ' + baseSize + 'pt → 見本の印字サイズ 約' + fittedSize.toFixed(1) + 'pt（枠に合わせて縮小）'
            : '見本の印字サイズ 約' + fittedSize.toFixed(1) + 'pt';
        }
      }
    });
  }

  function selectField(field) {
    setActiveSignatureForField(field);
    overlayEl.querySelectorAll('.field-box').forEach(el => el.classList.remove('is-selected'));
    const el = overlayEl.querySelector('[data-field-id="' + field.id + '"]');
    if (el) el.classList.add('is-selected');
    if (onFieldSelected) onFieldSelected(field);
  }

  function attachMoveHandlers(box, field, page) {
    let dragging = false;
    let startPx = 0, startPy = 0, startX = 0, startY = 0;

    box.addEventListener('pointerdown', (evt) => {
      if (evt.target.classList.contains('field-resize-handle')) return;
      dragging = true;
      box.setPointerCapture(evt.pointerId);
      startPx = evt.clientX;
      startPy = evt.clientY;
      startX = field.x;
      startY = field.y;
      evt.stopPropagation();
    });
    box.addEventListener('pointermove', (evt) => {
      if (!dragging) return;
      const scale = zoom.getScale();
      const dxPt = (evt.clientX - startPx) / scale;
      const dyPt = (evt.clientY - startPy) / scale; // 画面下方向 = PDF座標では減る方向
      field.x = startX + dxPt;
      field.y = startY - dyPt;
      const rect = PdfUtils.pdfRectToPixel(field, page.heightPt, scale);
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
    });
    box.addEventListener('pointerup', (evt) => {
      if (!dragging) return;
      dragging = false;
      box.releasePointerCapture(evt.pointerId);
      if (onPagesChanged) onPagesChanged();
    });
  }

  function attachResizeHandlers(handle, box, field, page, corner) {
    let resizing = false;
    let startPx = 0, startPy = 0, start = null;

    handle.addEventListener('pointerdown', (evt) => {
      resizing = true;
      handle.setPointerCapture(evt.pointerId);
      startPx = evt.clientX;
      startPy = evt.clientY;
      start = { x: field.x, y: field.y, width: field.width, height: field.height };
      evt.stopPropagation();
    });
    handle.addEventListener('pointermove', (evt) => {
      if (!resizing) return;
      if (['address','recipient_address'].includes(field.type)) delete field.addressRows;
      const scale = zoom.getScale();
      const dxPt = (evt.clientX - startPx) / scale;
      const dyPt = (evt.clientY - startPy) / scale;
      const MIN = 10;
      if (corner === 'se') {
        field.width = Math.max(MIN, start.width + dxPt);
        field.height = Math.max(MIN, start.height - dyPt);
      } else if (corner === 'sw') {
        const newWidth = Math.max(MIN, start.width - dxPt);
        field.x = start.x + (start.width - newWidth);
        field.width = newWidth;
        field.height = Math.max(MIN, start.height - dyPt);
      } else if (corner === 'ne') {
        field.width = Math.max(MIN, start.width + dxPt);
        const newHeight = Math.max(MIN, start.height + dyPt);
        field.y = start.y + (start.height - newHeight);
        field.height = newHeight;
      } else if (corner === 'nw') {
        const newWidth = Math.max(MIN, start.width - dxPt);
        const newHeight = Math.max(MIN, start.height + dyPt);
        field.x = start.x + (start.width - newWidth);
        field.y = start.y + (start.height - newHeight);
        field.width = newWidth;
        field.height = newHeight;
      }
      const rect = PdfUtils.pdfRectToPixel(field, page.heightPt, scale);
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
    });
    handle.addEventListener('pointerup', (evt) => {
      if (!resizing) return;
      resizing = false;
      handle.releasePointerCapture(evt.pointerId);
      selectField(field);
      if (onPagesChanged) onPagesChanged();
    });
  }

  // overlay自体へのドラッグ = 新しい項目を描く(パレットで型が選ばれている時だけ)
  function attachDrawHandlers() {
    let drawing = false;
    let startPx = 0, startPy = 0;
    let previewEl = null;

    overlayEl.addEventListener('pointerdown', (evt) => {
      if (!armedFieldType) return;
      if (evt.target !== overlayEl) return; // 既存の項目の上から始まった場合は無視
      drawing = true;
      overlayEl.setPointerCapture(evt.pointerId);
      const boundsRect = overlayEl.getBoundingClientRect();
      startPx = evt.clientX - boundsRect.left;
      startPy = evt.clientY - boundsRect.top;
      previewEl = document.createElement('div');
      previewEl.className = 'field-box field-box-preview';
      previewEl.style.left = startPx + 'px';
      previewEl.style.top = startPy + 'px';
      overlayEl.appendChild(previewEl);
    });
    overlayEl.addEventListener('pointermove', (evt) => {
      if (!drawing || !previewEl) return;
      const boundsRect = overlayEl.getBoundingClientRect();
      const curPx = evt.clientX - boundsRect.left;
      const curPy = evt.clientY - boundsRect.top;
      const left = Math.min(startPx, curPx);
      const top = Math.min(startPy, curPy);
      previewEl.style.left = left + 'px';
      previewEl.style.top = top + 'px';
      previewEl.style.width = Math.abs(curPx - startPx) + 'px';
      previewEl.style.height = Math.abs(curPy - startPy) + 'px';
    });
    overlayEl.addEventListener('pointerup', (evt) => {
      if (!drawing) return;
      drawing = false;
      overlayEl.releasePointerCapture(evt.pointerId);
      const boundsRect = overlayEl.getBoundingClientRect();
      const endPx = evt.clientX - boundsRect.left;
      const endPy = evt.clientY - boundsRect.top;
      if (previewEl) { previewEl.remove(); previewEl = null; }

      const page = pages[currentPageIndex];
      const scale = zoom.getScale();
      const rect = PdfUtils.pixelRectToPdfRect(startPx, startPy, endPx, endPy, page.heightPt, scale);
      // 誤クリックで極小の項目ができるのを防ぐ
      if (rect.width < 8 || rect.height < 8) return;

      const field = Models.createField({
        type: armedFieldType,
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        signOrder: getSignatureFields().length + 1,
      });
      // 直前に選択・配置した署名欄の項目を続けて配置できるようにする。
      // 利用者本人の氏名・住所は、記入者に依存しない共通情報として扱う。
      if (!['signature','recipient_name','recipient_address'].includes(field.type)) {
        const signature = getActiveSignatureField();
        if (signature) field.linkedFieldId = signature.id;
      }
      page.fields.push(field);
      renderFieldBoxes();
      selectField(field);
      if (onPagesChanged) onPagesChanged();
    });
  }

  function removeField(fieldId) {
    const page = pages[currentPageIndex];
    page.fields = page.fields.filter(f => f.id !== fieldId);
    signaturePreviews.delete(fieldId);
    if (activeSignatureId === fieldId) activeSignatureId = null;
    normalizeSignatureOrder();
    renderFieldBoxes();
    if (onPagesChanged) onPagesChanged();
  }

  return {
    init, loadPdfBytes, loadFromTemplate,
    zoomIn, zoomOut, fitToView, goToPage,
    getPageCount, getCurrentPageIndex, getPages, getSignatureFields, fitAddressRows, getActiveSignatureField, setActiveSignatureForField,
    setSignatureOrder, setSignaturePreview, getSignaturePreview, getSignatureSample, setArmedFieldType, attachDrawHandlers, renderFieldBoxes, removeField, setPrintPreviewVisible,
  };
})();
