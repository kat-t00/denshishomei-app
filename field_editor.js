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
  let onFieldSelected = null; // (field) => void
  let onPagesChanged = null; // () => void  (フィールドの追加・移動・削除の度に呼ぶ)

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

  function setArmedFieldType(type) {
    armedFieldType = type;
  }

  const FIELD_TYPE_LABELS = {
    signature: '署名欄',
    date: '日付欄',
    name: '氏名欄',
    relationship: '続柄欄',
    declaration_checkbox: '確認チェック欄',
    address: '住所欄',
  };

  // 「本人の署名欄を家族に直したのに、下の住所欄が本人のままだった」という事故が
  // 実際にあったため、役割を枠の色とラベルで常に見える化する(field-role-*はstyle.css側)。
  const ROLE_LABELS = { recipient: '本人', family: '家族', either: 'どちらでも' };

  function renderFieldBoxes() {
    overlayEl.innerHTML = '';
    const page = pages[currentPageIndex];
    const heightPt = page.heightPt;
    page.fields.forEach(field => {
      const box = document.createElement('div');
      // 署名欄は役割をテンプレート側で固定しない(署名時にその場で選ぶ設計)ため、
      // 役割の色分け・ラベル表示は氏名欄・住所欄などの付随項目だけに適用する
      const isSignature = field.type === 'signature';
      box.className = 'field-box field-type-' + field.type + (isSignature ? '' : ' field-role-' + field.assignedRole);
      box.dataset.fieldId = field.id;
      const rect = PdfUtils.pdfRectToPixel(field, heightPt, zoom.getScale());
      box.style.left = rect.left + 'px';
      box.style.top = rect.top + 'px';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';

      const labelSpan = document.createElement('span');
      labelSpan.className = 'field-box-label';
      const roleLabel = isSignature ? '' : (ROLE_LABELS[field.assignedRole] || '');
      labelSpan.textContent = (field.label || FIELD_TYPE_LABELS[field.type] || field.type) +
        (roleLabel ? '（' + roleLabel + '）' : '');
      box.appendChild(labelSpan);

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
    });
  }

  function selectField(field) {
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
        signOrder: page.fields.length + 1,
      });
      page.fields.push(field);
      renderFieldBoxes();
      selectField(field);
      if (onPagesChanged) onPagesChanged();
    });
  }

  function removeField(fieldId) {
    const page = pages[currentPageIndex];
    page.fields = page.fields.filter(f => f.id !== fieldId);
    renderFieldBoxes();
    if (onPagesChanged) onPagesChanged();
  }

  return {
    init, loadPdfBytes, loadFromTemplate,
    zoomIn, zoomOut, fitToView, goToPage,
    getPageCount, getCurrentPageIndex, getPages,
    setArmedFieldType, attachDrawHandlers, renderFieldBoxes, removeField,
  };
})();
