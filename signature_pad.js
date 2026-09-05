// 手書き署名をcanvasに描かせるための部品。指・Apple Pencil・タッチペンいずれでも
// 同じ動作になるようPointer Eventsを使う。高齢者が誤ってワンタップしただけで
// 署名成立にならないよう、最小ストローク量のチェックを持つ。
const SignaturePad = (() => {
  const MIN_PATH_LENGTH = 40; // px。これ未満なら「署名として小さすぎる」扱い
  const MIN_BOUNDS_SIZE = 15; // px。幅・高さともこれ未満なら不十分とみなす

  function create(canvasEl, onStrokeChange) {
    const ctx = canvasEl.getContext('2d');
    let drawing = false;
    let activePointerId = null; // 今描画中のポインタだけを追跡し、他の指(手のひら等)の入力を無視する
    let sawPenInput = false; // 一度でもApple Pencil等のペンを使ったら、以後の指タッチは手のひらとみなす
    let lastX = 0, lastY = 0;
    let pathLength = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasStroke = false;

    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#2f3b52';

    function updateBounds(x, y) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }

    function getPos(evt) {
      const rect = canvasEl.getBoundingClientRect();
      return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
    }

    // 署名中に手のひらが画面に触れると、Pointer Eventsは区別なく全部拾ってしまうため、
    // 何も対策しないと手のひらの接地点に描画位置が飛んでしまう(パームリジェクション対策)。
    // ①ペンでの入力歴があれば、以後の指タッチは常に無視する
    // ②描画中は、今描いているポインタ以外の入力(2本目の指等)を無視する
    // ③ただしペンは常に優先し、指(≒手のひら)が先に触れていても割り込んで描画を奪える
    // iPadはペンが少し静止すると「長押しメニュー」判定のタイマーが走り、
    // 何もしないと描画中でも定期的にpointercancelを送ってきて線が途切れる。
    // preventDefault()でこの長押しジェスチャー自体を発生させない
    canvasEl.addEventListener('contextmenu', (evt) => evt.preventDefault());

    // iPadのSafariはsetPointerCapture/releasePointerCaptureの解放が内部的に不完全で、
    // 1回おきに次のストロークのpointer移動イベントを取りこぼす既知の不具合があるため、
    // キャプチャは使わず、move/up/cancelはwindow側で拾う(canvas外に指が出ても追従できる利点もある)
    canvasEl.addEventListener('pointerdown', (evt) => {
      if (evt.pointerType === 'touch' && sawPenInput) return;
      if (evt.pointerType !== 'pen' && drawing) return;
      evt.preventDefault();
      if (evt.pointerType === 'pen') sawPenInput = true;
      drawing = true;
      activePointerId = evt.pointerId;
      hasStroke = true;
      const pos = getPos(evt);
      lastX = pos.x; lastY = pos.y;
      updateBounds(pos.x, pos.y);
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      // ワンタップだけでも点が見えるよう小さい円を描いておく(直後にmoveがあれば線で上書きされる)
      ctx.arc(pos.x, pos.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
    });

    function handleMove(evt) {
      if (!drawing || evt.pointerId !== activePointerId) return;
      evt.preventDefault();
      const pos = getPos(evt);
      const dx = pos.x - lastX, dy = pos.y - lastY;
      pathLength += Math.sqrt(dx * dx + dy * dy);
      updateBounds(pos.x, pos.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      lastX = pos.x; lastY = pos.y;
      if (onStrokeChange) onStrokeChange(isValid());
    }
    window.addEventListener('pointermove', handleMove, { passive: false });

    function endStroke(evt) {
      if (!drawing || (evt && evt.pointerId !== activePointerId)) return;
      drawing = false;
      activePointerId = null;
      if (onStrokeChange) onStrokeChange(isValid());
    }
    window.addEventListener('pointerup', endStroke);
    window.addEventListener('pointercancel', endStroke);

    // 署名モーダルを閉じる時に呼ぶ。windowに貼ったリスナーは自動では消えないため、
    // 呼び忘れると署名のたびにリスナーが積み重なっていく
    function destroy() {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', endStroke);
      window.removeEventListener('pointercancel', endStroke);
    }

    function isValid() {
      if (!hasStroke) return false;
      const width = maxX - minX;
      const height = maxY - minY;
      return pathLength >= MIN_PATH_LENGTH && width >= MIN_BOUNDS_SIZE && height >= MIN_BOUNDS_SIZE;
    }

    function clear() {
      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      drawing = false;
      activePointerId = null;
      hasStroke = false;
      pathLength = 0;
      minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
      if (onStrokeChange) onStrokeChange(false);
    }

    // 描いた線の範囲だけを切り出して画像化する。パッド全体(余白だらけ)をそのまま
    // 書き出すと、配置先の枠をどれだけ広げても線自体は大きくならない(縮小されるだけ)ため、
    // 実際に描かれた範囲にトリミングしてから渡すことで、枠の大きさに応じて線も大きく表示される
    function toDataUrl() {
      if (!hasStroke) return canvasEl.toDataURL('image/png');
      const margin = 6; // 線の端が切れないよう少し余白を残す
      const cropX = Math.max(0, Math.floor(minX - margin));
      const cropY = Math.max(0, Math.floor(minY - margin));
      const cropW = Math.min(canvasEl.width, Math.ceil(maxX + margin)) - cropX;
      const cropH = Math.min(canvasEl.height, Math.ceil(maxY + margin)) - cropY;
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = cropW;
      cropCanvas.height = cropH;
      cropCanvas.getContext('2d').drawImage(canvasEl, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      return cropCanvas.toDataURL('image/png');
    }

    return { clear, isValid, toDataUrl, destroy };
  }

  return { create };
})();
