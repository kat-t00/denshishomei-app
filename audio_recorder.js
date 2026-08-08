// 重要事項説明の様子を録音するための部品。MediaRecorder APIを使う。
// signature_pad.jsと同じく「作る・使う・片付ける」だけのシンプルな部品として切り出す。
// 録音データは他のセッション情報と同じくメモリ内のみで保持し、自動保存はしない。
const AudioRecorder = (() => {
  function isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }

  // マイクの使用許可を求めて録音を開始する。
  // 戻り値のstop()を呼ぶと録音を止めてBlobを返す(Promise)。cancel()は保存せずに中断する。
  async function start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (evt) => {
      if (evt.data && evt.data.size > 0) chunks.push(evt.data);
    });

    // マイクを確実に解放するため、停止時は必ずtrackをstopする
    const stopped = new Promise((resolve) => {
      recorder.addEventListener('stop', () => {
        stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
      });
    });

    recorder.start();

    return {
      stop() {
        recorder.stop();
        return stopped;
      },
      cancel() {
        stream.getTracks().forEach((t) => t.stop());
      },
    };
  }

  return { isSupported, start };
})();
