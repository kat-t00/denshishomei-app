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
    const auditRecord = await Audit.buildAuditRecord(session, finalPdfBytes);
    const recipientPart = sanitizeForFileName(session.recipientName);
    return {
      pdfBytes: finalPdfBytes,
      audioBytes: audioBytes || null,
      audioMimeType: audioMimeType || null,
      auditJson: JSON.stringify(auditRecord, null, 2),
      hash: auditRecord.finalPdfHashSha256,
      fileNameBase: (recipientPart ? recipientPart + '_' : '')
        + (template.name || '契約書') + '_' + session.verificationId.slice(0, 8),
    };
  }

  function downloadBlob(bytes, fileName, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // MVPのデフォルトの保存先: 端末へのダウンロード。
  // Phase 2ではここにcloudUploadSink等を追加してsinkFnとして渡せばよい。
  function downloadSink(artifacts) {
    downloadBlob(artifacts.pdfBytes, artifacts.fileNameBase + '.pdf', 'application/pdf');
    downloadBlob(new TextEncoder().encode(artifacts.auditJson), artifacts.fileNameBase + '_監査記録.json', 'application/json');
    if (artifacts.audioBytes) {
      const ext = audioFileExtension(artifacts.audioMimeType);
      downloadBlob(artifacts.audioBytes, artifacts.fileNameBase + '_説明音声.' + ext, artifacts.audioMimeType || 'audio/webm');
    }
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
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const count = TemplateStore.importAll(data);
        onDone(null, count);
      } catch (e) {
        onDone(e, 0);
      }
    };
    reader.readAsText(file);
  }

  return { buildSignedArtifacts, saveArtifacts, downloadSink, downloadBlob, exportTemplatesBackup, importTemplatesBackup, audioFileExtension };
})();
