// 完成した署名済みPDF・監査記録の保存を担当。
// buildSignedArtifacts()は純粋にデータを作るだけ、saveArtifacts()が実際の保存先に渡す部分。
// sinkFnを差し替え可能にしておくことで、Phase 2でクラウド保存を追加する時に
// buildSignedArtifacts側を変更せずに済むようにしている。
const ExportModule = (() => {
  // ファイル名に使えない文字(OS共通でNGなもの)を除去する
  function sanitizeForFileName(text) {
    return (text || '').replace(/[\\/:*?"<>|]/g, '').trim();
  }

  // 録音のMIMEタイプ(ブラウザが実際に使ったコーデック)から、再生アプリが正しく認識できる
  // 拡張子を決める。iPadのSafariはwebmで録音できず実際はaudio/mp4(m4a相当)になるため、
  // 拡張子を決め打ちすると中身と不一致になり再生できないファイルが出来上がってしまう
  function audioFileExtension(mimeType) {
    if (!mimeType) return 'webm';
    if (mimeType.includes('mp4')) return 'm4a';
    if (mimeType.includes('ogg')) return 'ogg';
    return 'webm';
  }

  // audioBytesは任意(重要事項説明の録音を添付した場合のみ)。ハッシュは既にsession側に
  // 記録済み(finalizeSigning側でPDF生成前に計算しておく必要があるため、ここでは計算しない)
  async function buildSignedArtifacts(template, session, finalPdfBytes, audioBytes, audioMimeType) {
    const auditRecord = await Audit.buildAuditRecord(session, finalPdfBytes, template.name);
    const recipientPart = sanitizeForFileName(session.recipientName);
    return {
      pdfBytes: finalPdfBytes,
      audioBytes: audioBytes || null,
      audioMimeType: audioMimeType || null,
      auditJson: JSON.stringify(auditRecord, null, 2),
      hash: auditRecord.finalPdfHashSha256,
      fileNameBase: (recipientPart ? recipientPart + '_' : '')
        + (sanitizeForFileName(template.name) || '契約書') + '_' + session.verificationId.slice(0, 8),
    };
  }

  function downloadBlob(bytes, fileName, mimeType) {
    // iOS Safariは中身がPDF等の「その場で開ける」形式だと、download属性を無視して
    // 内蔵ビューアーで開いてしまいダウンロードされない。Blob自体を汎用形式にすり替えて
    // 「開けないファイル」と誤認させ、確実にダウンロードさせる(ファイル名の拡張子は
    // 正しいものを渡すので、保存後は普通にPDFとして開ける)
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function listArtifactFiles(artifacts) {
    const files = [
      { label: '署名済みPDF', bytes: artifacts.pdfBytes, name: artifacts.fileNameBase + '.pdf', mimeType: 'application/pdf' },
      { label: '監査記録', bytes: new TextEncoder().encode(artifacts.auditJson), name: artifacts.fileNameBase + '_監査記録.json', mimeType: 'application/json' },
    ];
    if (artifacts.audioBytes) {
      files.push({ label: '説明音声', bytes: artifacts.audioBytes,
        name: artifacts.fileNameBase + '_説明音声.' + audioFileExtension(artifacts.audioMimeType),
        mimeType: artifacts.audioMimeType || 'audio/webm' });
    }
    return files;
  }

  function toShareFile(file) { return new File([file.bytes],file.name,{type:file.mimeType}); }
  function canShareFile(file) {
    try { return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({files:[toShareFile(file)]}); } catch (_) { return false; }
  }
  async function shareFile(file) {
    if (!canShareFile(file)) throw new Error('この端末ではこのファイルの共有に対応していません。');
    await navigator.share({files:[toShareFile(file)]});
  }

  // 複数保存が制限される端末に配慮して間隔を空ける。
  function downloadSink(artifacts) {
    const files = [
      [artifacts.pdfBytes, artifacts.fileNameBase + '.pdf', 'application/pdf'],
      [new TextEncoder().encode(artifacts.auditJson), artifacts.fileNameBase + '_監査記録.json', 'application/json'],
    ];
    if (artifacts.audioBytes) {
      const ext = audioFileExtension(artifacts.audioMimeType);
      files.push([artifacts.audioBytes, artifacts.fileNameBase + '_説明音声.' + ext, artifacts.audioMimeType || 'audio/webm']);
    }
    files.forEach(([bytes, name, mimeType], i) => {
      setTimeout(() => downloadBlob(bytes, name, mimeType), i * 600);
    });
  }

  function saveArtifacts(artifacts, sinkFn) {
    (sinkFn || downloadSink)(artifacts);
  }

  function exportTemplatesBackup(ids) {
    const data = ids ? TemplateStore.exportSelected(ids) : TemplateStore.exportAll();
    downloadBlob(new TextEncoder().encode(JSON.stringify(data, null, 2)), 'keiyaku_templates_backup.json', 'application/json');
  }

  function importTemplatesBackup(file, onDone) {
    const reader = new FileReader();
    reader.onerror = () => onDone(new Error('バックアップファイルを読み取れませんでした。'), 0);
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data)) throw new Error('バックアップファイルの形式が正しくありません。');
        for (const template of data) {
          if (!template || !Array.isArray(template.pages) || typeof template.pdfBase64 !== 'string') throw new Error('書式の形式が正しくありません。');
          const doc = await PdfUtils.loadPdf(PdfUtils.base64ToArrayBuffer(template.pdfBase64));
          try {
            if (doc.numPages !== template.pages.length) throw new Error('PDFのページ数と書式の設定が一致しません。');
            for (let index = 0; index < doc.numPages; index++) {
              const viewport = (await doc.getPage(index + 1)).getViewport({scale:1});
              if (Math.abs(viewport.width-template.pages[index].widthPt)>0.1 || Math.abs(viewport.height-template.pages[index].heightPt)>0.1) throw new Error('PDFのページサイズと書式の設定が一致しません。');
            }
          } finally { doc.destroy(); }
        }
        const count = await TemplateStore.importAll(data);
        onDone(null, count);
      } catch (e) {
        onDone(e, 0);
      }
    };
    reader.readAsText(file);
  }

  return { canShareFile, shareFile, buildSignedArtifacts, listArtifactFiles, saveArtifacts, downloadSink, downloadBlob, exportTemplatesBackup, importTemplatesBackup, audioFileExtension };
})();
