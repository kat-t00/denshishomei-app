// 手書き署名をcanvasに描かせるための部品。指・Apple Pencil・タッチペンいずれでも
// 同じ動作になるようPointer Eventsを使う。高齢者が誤ってワンタップしただけで
// 署名成立にならないよう、最小ストローク量のチェックを持つ。
const SignaturePad = (() => {
  const MIN_PATH_LENGTH = 40; // px。これ未満なら「署名として小さすぎる」扱い
  const MIN_BOUNDS_SIZE = 15; // px。幅または高さで、ごく小さい筆跡を除く

  function create(canvasEl, onStrokeChange, onInterrupted) {
    const ctx = canvasEl.getContext('2d');
    let drawing = false;
    let activePointerId = null; // 今描画中のポインタだけを追跡し、他の指(手のひら等)の入力を無視する
    let sawPenInput = false; // 一度でもApple Pencil等のペンを使ったら、以後の指タッチは手のひらとみなす
    let lastX = 0, lastY = 0;
    let pathLength = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasStroke = false;
    let activePointerType = null;
    let strokes = [];
    let currentStroke = null;

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
      return {
        x: Math.max(0, Math.min(canvasEl.width, (evt.clientX - rect.left) * canvasEl.width / rect.width)),
        y: Math.max(0, Math.min(canvasEl.height, (evt.clientY - rect.top) * canvasEl.height / rect.height)),
      };
    }

    // 署名中に手のひらが画面に触れると、Pointer Eventsは区別なく全部拾ってしまうため、
    // 何も対策しないと手のひらの接地点に描画位置が飛んでしまう(パームリジェクション対策)。
    // ①ペンでの入力歴があれば、以後の指タッチは常に無視する
    // ②描画中は、今描いているポインタ以外の入力(2本目の指等)を無視する
    // ③ただしペンは常に優先し、指(≒手のひら)が先に触れていても割り込んで描画を奪える
    // pointercancelの原因は端末によって異なる。失われた座標は推測で補わない。
    function preventDefault(evt) { if (evt.cancelable) evt.preventDefault(); }
    canvasEl.addEventListener('contextmenu', preventDefault);
    // iOSのTouch Events側にも描画領域でのジェスチャー抑止を指定する。
    canvasEl.addEventListener('touchstart', preventDefault, { passive: false });
    canvasEl.addEventListener('touchmove', preventDefault, { passive: false });

    // 過去の実機対策を維持し、キャプチャの代わりにwindowでmove/upを拾う。
    function startStroke(evt) {
      if (evt.pointerType === 'touch' && sawPenInput) return;
      if (evt.pointerType !== 'pen' && drawing) return;
      if (evt.button !== 0) return;
      evt.preventDefault();
      if (evt.pointerType === 'pen') sawPenInput = true;
      drawing = true;
      activePointerId = evt.pointerId;
      activePointerType = evt.pointerType;
      hasStroke = true;
      // canvasサイズ変更で初期化された描画属性もここで戻す。
      ctx.lineWidth = 2.5 * canvasEl.width / canvasEl.getBoundingClientRect().width;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = '#2f3b52'; ctx.fillStyle = '#2f3b52';
      const pos = getPos(evt);
      lastX = pos.x; lastY = pos.y;
      currentStroke = {width:ctx.lineWidth,points:[pos]}; strokes.push(currentStroke);
      updateBounds(pos.x, pos.y);
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
      // ワンタップだけでも点が見えるよう小さい円を描いておく(直後にmoveがあれば線で上書きされる)
      ctx.arc(pos.x, pos.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
    }
    canvasEl.addEventListener('pointerdown', startStroke);

    function drawPoint(evt) {
      const pos = getPos(evt);
      const dx = pos.x - lastX, dy = pos.y - lastY;
      if (dx === 0 && dy === 0) return;
      currentStroke.points.push(pos);
      pathLength += Math.sqrt(dx * dx + dy * dy);
      updateBounds(pos.x, pos.y);
      // 過去の全経路を毎回strokeすると筆記量に伴って負荷が増えるため差分だけ描く。
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      lastX = pos.x; lastY = pos.y;
    }
    function handleMove(evt) {
      if (!drawing || evt.pointerId !== activePointerId) return;
      preventDefault(evt);
      const points = typeof evt.getCoalescedEvents === 'function' ? evt.getCoalescedEvents() : [];
      for (const point of points) drawPoint(point);
      drawPoint(evt);
      if (onStrokeChange) onStrokeChange(isValid());
    }
    window.addEventListener('pointermove', handleMove, { passive: false });

    function endStroke(evt) {
      if (!drawing || (evt && evt.pointerId !== activePointerId)) return;
      if (evt && evt.type === 'pointerup') drawPoint(evt);
      drawing = false;
      activePointerId = null;
      activePointerType = null;
      currentStroke = null;
      if (evt && evt.type === 'pointercancel' && onInterrupted) onInterrupted();
      if (onStrokeChange) onStrokeChange(isValid());
    }
    window.addEventListener('pointerup', endStroke);
    window.addEventListener('pointercancel', endStroke);

    // 署名モーダルを閉じる時に呼ぶ。windowに貼ったリスナーは自動では消えないため、
    // 呼び忘れると署名のたびにリスナーが積み重なっていく
    function destroy() {
      endStroke();
      canvasEl.removeEventListener('pointerdown', startStroke);
      canvasEl.removeEventListener('contextmenu', preventDefault);
      canvasEl.removeEventListener('touchstart', preventDefault);
      canvasEl.removeEventListener('touchmove', preventDefault);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', endStroke);
      window.removeEventListener('pointercancel', endStroke);
    }

    function isValid() {
      if (!hasStroke) return false;
      const width = maxX - minX;
      const height = maxY - minY;
      return pathLength >= MIN_PATH_LENGTH && Math.max(width, height) >= MIN_BOUNDS_SIZE;
    }

    function clear() {
      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
      drawing = false;
      activePointerId = null;
      activePointerType = null;
      currentStroke = null; strokes = [];
      hasStroke = false;
      pathLength = 0;
      minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
      if (onStrokeChange) onStrokeChange(false);
    }

    // 通常の筆記は差分描画のまま。取り消し操作の時だけ残った筆跡を再描画する。
    function undo() {
      if (!strokes.length) return;
      endStroke(); strokes.pop();
      ctx.clearRect(0,0,canvasEl.width,canvasEl.height);
      pathLength = 0; minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
      hasStroke = strokes.length > 0;
      for (const stroke of strokes) {
        ctx.lineWidth = stroke.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.strokeStyle = '#2f3b52'; ctx.fillStyle = '#2f3b52';
        const first = stroke.points[0];
        ctx.beginPath(); ctx.arc(first.x,first.y,stroke.width/2,0,Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(first.x,first.y); updateBounds(first.x,first.y);
        for (let index=1; index<stroke.points.length; index++) {
          const point = stroke.points[index], previous = stroke.points[index-1];
          ctx.lineTo(point.x,point.y); updateBounds(point.x,point.y);
          pathLength += Math.hypot(point.x-previous.x,point.y-previous.y);
        }
        ctx.stroke();
      }
      if (onStrokeChange) onStrokeChange(isValid());
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

    return { clear, undo, canUndo: () => strokes.length > 0, isValid, toDataUrl, destroy, isDrawingWithPen: () => drawing && activePointerType === 'pen' };
  }

  return { create };
})();
