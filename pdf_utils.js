// PDF描画・座標変換の共通処理（テンプレート作成モード・入力モードの両方で使う）
const PdfUtils = (() => {
  // file://で直接HTMLを開いた場合、Chrome等はfile://パスからのWorker生成を制限し、
  // pdf.jsが無反応のまま固まることがある(タブレットに単体のHTMLファイルだけコピーして使う運用で実際に発生)。
  // pdf.worker.min.jsの中身をlib/pdf_worker_src.jsで文字列として読み込み、Blob URL化することで回避する。
  const workerBlob = new Blob([PDF_WORKER_SOURCE], { type: 'text/javascript' });
  pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);

  const DISPLAY_SCALE = 1.4; // 画面表示用の標準の拡大率（PDFのポイント → 画面ピクセル。ズーム100%の基準値）

  async function loadPdf(arrayBuffer) {
    return pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  }

  // ページを実際に描画せず、PDF上の実サイズ（ポイント単位）だけを取得する（ズームのfit計算に使う）
  async function getPageSize(pdfDoc, pageNumber) {
    const page = await pdfDoc.getPage(pageNumber);
    return {
      widthPt: page.view[2] - page.view[0],
      heightPt: page.view[3] - page.view[1],
    };
  }

  // 指定ページをcanvasに描画し、PDF上の実サイズ（ポイント単位）を返す
  async function renderPageToCanvas(pdfDoc, pageNumber, canvas, scale = DISPLAY_SCALE) {
    const page = await pdfDoc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return {
      widthPt: page.view[2] - page.view[0],
      heightPt: page.view[3] - page.view[1],
    };
  }

  // 画面上のクリック位置（canvas左上原点・ピクセル） → PDFの座標（左下原点・ポイント）
  function pixelToPdfPoint(px, py, heightPt, scale = DISPLAY_SCALE) {
    return {
      x: px / scale,
      y: heightPt - (py / scale),
    };
  }

  // PDFの座標（左下原点・ポイント） → 画面上の表示位置（canvas左上原点・ピクセル）
  function pdfPointToPixel(x, y, heightPt, scale = DISPLAY_SCALE) {
    return {
      left: x * scale,
      top: (heightPt - y) * scale,
    };
  }

  // 画面上でドラッグした2点（ピクセル） → PDFの四角形（左下原点・ポイント、x,yは左下角）
  function pixelRectToPdfRect(px1, py1, px2, py2, heightPt, scale = DISPLAY_SCALE) {
    const left = Math.min(px1, px2);
    const right = Math.max(px1, px2);
    const top = Math.min(py1, py2);
    const bottom = Math.max(py1, py2);
    return {
      x: left / scale,
      y: heightPt - (bottom / scale),
      width: (right - left) / scale,
      height: (bottom - top) / scale,
    };
  }

  // PDFの四角形（左下原点・ポイント） → 画面上の表示位置・サイズ（ピクセル）
  function pdfRectToPixel(rect, heightPt, scale = DISPLAY_SCALE) {
    return {
      left: rect.x * scale,
      top: (heightPt - rect.y - rect.height) * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    };
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  // 大きいファイルでもスタックオーバーフローしないよう分割してbase64化する
  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  // ズーム操作の状態管理（テンプレ作成・入力タブでそれぞれ1つずつ、独立して持つ）。
  // 「感覚的に拡大縮小したい」という要望から、段階的なズームボタン＋全体表示ボタンを用意した。
  // 連続的なピンチズームよりシンプルで壊れにくいことを優先している
  function createZoomControl() {
    const LEVELS = [0.5, 0.75, 1.0, 1.5, 2.0, 3.0]; // DISPLAY_SCALEに対する倍率（100%表示 = 従来の固定表示）
    let levelIndex = 2; // 1.0 = これまでの標準表示
    let fitScale = null; // 全体表示中はこちらを優先して使う（nullなら通常のLEVELSベース）
    let pageWidthPt = 0;
    let pageHeightPt = 0;

    function setPageSize(widthPt, heightPt) {
      pageWidthPt = widthPt;
      pageHeightPt = heightPt;
    }

    function getScale() {
      return fitScale != null ? fitScale : DISPLAY_SCALE * LEVELS[levelIndex];
    }

    function getLabel() {
      return fitScale != null ? '全体表示' : Math.round(LEVELS[levelIndex] * 100) + '%';
    }

    // 全体表示（fit）中にズームボタンを押した時、levelIndexが古いまま飛び級しないよう、
    // 常に「今実際に表示されている倍率」を基準に1段階だけ上下させる
    function zoomIn() {
      const current = getScale();
      fitScale = null;
      const idx = LEVELS.findIndex(l => DISPLAY_SCALE * l > current + 0.001);
      levelIndex = idx === -1 ? LEVELS.length - 1 : idx;
    }

    function zoomOut() {
      const current = getScale();
      fitScale = null;
      let idx = 0;
      for (let i = LEVELS.length - 1; i >= 0; i--) {
        if (DISPLAY_SCALE * LEVELS[i] < current - 0.001) { idx = i; break; }
      }
      levelIndex = idx;
    }

    // wrapElの表示エリアいっぱいにページ全体（幅・高さとも）が収まる倍率を計算する
    function fitToView(wrapEl) {
      if (!pageWidthPt || !pageHeightPt) return;
      const padding = 24; // .pdf-stage-wrapの内側パディング分
      const availWidth = Math.max(wrapEl.clientWidth - padding, 100);
      const availHeight = Math.max(wrapEl.clientHeight - padding, 100);
      fitScale = Math.max(Math.min(availWidth / pageWidthPt, availHeight / pageHeightPt), 0.2);
    }

    return { setPageSize, getScale, getLabel, zoomIn, zoomOut, fitToView };
  }

  return {
    DISPLAY_SCALE,
    loadPdf,
    getPageSize,
    renderPageToCanvas,
    pixelToPdfPoint,
    pdfPointToPixel,
    pixelRectToPdfRect,
    pdfRectToPixel,
    base64ToArrayBuffer,
    arrayBufferToBase64,
    createZoomControl,
  };
})();
