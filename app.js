// 起動処理・画面遷移・各モジュールの配線。DOMContentLoaded時に一度だけ実行する。
(function () {
  let currentEditingTemplateId = null;
  let currentPdfBase64 = null;
  let currentSigningTemplate = null;
  let signingUiState = { phase: 'recipient_name', draft: {} };
  let lastVoidRecord = null;
  let voidPdfFile = null;
  const templateThumbCache = new Map(); // key: id+'_'+updatedAt -> dataURL(セッション中のみのキャッシュ)

  // 従来版の途中保存ファイルに含まれる音声だけ、再保存・照合のため保持する。
  let sessionAudioBlob = null;
  // 完成したバイト列を再生成せず再保存する。端末への自動保存はしない。
  let completedExport = null;
  let signingBusy = false;

  const el = {};

  function q(id) { return document.getElementById(id); }

  function hasPendingSigning() {
    return !!currentSigningTemplate && !completedExport;
  }

  function showScreen(name) {
    if (signingBusy) { showToast('書類を作成中です。完了までお待ちください。'); return false; }
    if (name !== 'verification') VerificationView.reset();
    document.querySelectorAll('.app-screen').forEach(s => s.classList.remove('is-active'));
    q('screen-' + name).classList.add('is-active');
  }

  function showToast(message, durationMs) {
    el.saveToast.textContent = message;
    el.saveToast.classList.remove('hidden');
    el.saveToast.classList.add('visible');
    setTimeout(() => el.saveToast.classList.remove('visible'), durationMs || 2200);
  }

  // PDF読み込み(pdf.jsのWorker初期化)が環境によっては無反応のまま固まることがあるため、
  // 一定時間で諦めてエラーとして扱えるようにする(無言のまま固まって不親切になるのを防ぐ)
  function withTimeout(promise, ms, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
    ]);
  }

  const PDF_LOAD_ERROR_MESSAGE = 'PDFの読み込みに失敗しました。\n\n' +
    'このファイルを直接ダブルクリックで開いている場合、index.html（またはkeiyaku_standalone.html）と' +
    '同じフォルダに「lib」フォルダが一緒に置かれているかご確認ください。\n' +
    '改善しない場合は、ブラウザを再読み込みしてから別のPDFで再度お試しください。';

  // ===== ホーム画面 =====
  const THUMB_SIZE_PRESETS = { small: 160, medium: 240, large: 320 };
  const THUMB_SIZE_STORAGE_KEY = 'keiyaku_thumb_size_v1';

  function applyThumbSize(size) {
    const px = THUMB_SIZE_PRESETS[size] || THUMB_SIZE_PRESETS.medium;
    el.templateList.style.setProperty('--card-min-width', px + 'px');
    el.thumbSizeControl.querySelectorAll('.thumb-size-btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.size === size);
    });
    localStorage.setItem(THUMB_SIZE_STORAGE_KEY, size);
  }

  function renderHomeTemplateList() {
    Forms.renderTemplateList(el.templateList, TemplateStore.list(), {
      onUse: (id) => beginSigningWithTemplate(id),
      onEdit: (id) => openTemplateForEditing(id),
      onDelete: async (id) => {
        if (confirm('このテンプレートを削除しますか？（過去に署名した記録には影響しません）')) {
          try { await TemplateStore.remove(id); } catch(error) { alert(error.message); return; }
          renderHomeTemplateList();
        }
      },
      onThumbRequest: (t, imgEl) => loadTemplateThumbnail(t).then(dataUrl => {
        if (dataUrl) imgEl.src = dataUrl;
      }),
    });
  }


  // テンプレート一覧のサムネイル(1ページ目を縮小したもの)を作る。
  // 一覧はPDF本体を含まない軽量データなので、表示のたびに個別取得して非同期で埋める。
  // 更新されない限り再生成しないよう、id+updatedAtをキーにキャッシュする。
  async function loadTemplateThumbnail(t) {
    const cacheKey = t.id + '_' + t.updatedAt;
    if (templateThumbCache.has(cacheKey)) return templateThumbCache.get(cacheKey);
    const full = TemplateStore.get(t.id);
    if (!full || !full.pdfBase64) return null;
    try {
      const bytes = PdfUtils.base64ToArrayBuffer(full.pdfBase64);
      const pdfDoc = await PdfUtils.loadPdf(bytes);
      const canvas = document.createElement('canvas');
      await PdfUtils.renderPageToCanvas(pdfDoc, 1, canvas, 0.35);
      const dataUrl = canvas.toDataURL('image/png');
      templateThumbCache.set(cacheKey, dataUrl);
      return dataUrl;
    } catch (e) {
      console.error('サムネイルの生成に失敗しました', e);
      return null;
    }
  }

  function beginSigningWithTemplate(id, resignOf) {
    const template = TemplateStore.get(id);
    if (!template) return;
    const hasSignatureField = template.pages.some(p => p.fields.some(f => f.type === 'signature'));
    if (!hasSignatureField) {
      alert('このテンプレートには署名欄がありません。「編集」から署名欄を追加してください。');
      return;
    }
    const templateErrors = Models.validateTemplate(template);
    if (templateErrors.length) { alert('署名前にテンプレートを修正してください。\n' + templateErrors.join('\n')); return; }
    if (completedExport && !completedExport.confirmed) {
      alert('先に「直前の署名書類」から必要なファイルを保存し、開けることを確認してください。');
      showScreen('signing');
      renderCompletedExport();
      return;
    }
    if (signingBusy) { alert('書類を作成中です。完了までお待ちください。'); return; }
    if (hasPendingSigning() && !confirm('途中の契約があります。破棄して新しい契約を始めますか？\nキャンセルすると途中の契約に戻ります。')) {
      showScreen('signing'); renderSigningStep(); return;
    }
    completedExport = null;
    q('btn-nav-resume').classList.remove('hidden');
    q('btn-nav-draft-save').classList.remove('hidden');
    q('btn-nav-last-export').classList.add('hidden');
    currentSigningTemplate = template;
    signingUiState = { phase: 'recipient_name', draft: {}, resignOf: resignOf || null };
    sessionAudioBlob = null;
    showScreen('signing');
    renderSigningStep();
  }

  // ===== テンプレート編集画面 =====
  function updatePageIndicator() {
    el.pageIndicator.textContent = (FieldEditor.getCurrentPageIndex() + 1) + ' / ' + FieldEditor.getPageCount();
    updateEditorFieldSummary();
    updatePdfStorageStatus();
  }

  async function updatePdfStorageStatus() {
    const pdf = currentPdfBase64;
    if (!pdf) { q('pdf-file-status').textContent = ''; return; }
    const info = await TemplateStore.getStorageInfo();
    if (pdf !== currentPdfBase64) return;
    const mb = bytes => (bytes / (1024*1024)).toFixed(1);
    let text = FieldEditor.getPageCount() + 'ページ ／ PDF約' + mb(pdf.length*3/4) + 'MB。保存済み書式：' + info.templateCount + '件。';
    if (info.estimate && Number.isFinite(info.estimate.quota) && Number.isFinite(info.estimate.usage)) text += ' 保存可能容量の目安：約' + mb(Math.max(0,info.estimate.quota-info.estimate.usage)) + 'MB。';
    q('pdf-file-status').textContent = text;
  }

  function backupEditingTemplate() {
    if (!currentPdfBase64) { alert('先にPDFを選択してください。'); return; }
    const template = Models.createTemplate({name:el.templateNameInput.value.trim() || '作成途中の書式',versionLabel:el.templateVersionLabelInput.value.trim(),pdfBase64:currentPdfBase64,
      signingMode:q('template-signing-mode').value,requireAdditionalForScribe:q('template-require-additional-for-scribe').checked,
      pages:JSON.parse(JSON.stringify(FieldEditor.getPages()))});
    ExportModule.downloadBlob(JSON.stringify({format:'keiyaku-template-draft',version:1,template}), '編集中の書式_'+Date.now()+'.json','application/json');
  }

  async function restoreEditingTemplate(data) {
    const template = data.template;
    if (data.version !== 1 || !template || typeof template.name !== 'string' || typeof template.pdfBase64 !== 'string' || !Array.isArray(template.pages) || !template.pages.every(page=>page && Array.isArray(page.fields) && page.fields.every(field=>field && typeof field === 'object'))) throw new Error('編集中の書式ファイルの形式が正しくありません。');
    if (template.pdfBase64.length*3/4 > TemplateStore.MAX_PDF_BYTES+2) throw new Error('PDFは1書式20MBまでです。');
    const pdf = await PdfUtils.loadPdf(PdfUtils.base64ToArrayBuffer(template.pdfBase64));
    try {
      if (pdf.numPages !== template.pages.length) throw new Error('PDFのページ数と配置情報が一致しません。');
      for (let number=1; number<=pdf.numPages; number++) { const size=await PdfUtils.getPageSize(pdf,number); const page=template.pages[number-1]; if (Math.abs(size.widthPt-page.widthPt)>0.1 || Math.abs(size.heightPt-page.heightPt)>0.1 || !Number.isFinite(page.widthPt) || !Number.isFinite(page.heightPt)) throw new Error('PDFの寸法と配置情報が一致しません。'); }
    } finally { pdf.destroy(); }
    currentEditingTemplateId=null; currentPdfBase64=template.pdfBase64;
    el.templateNameInput.value=template.name; el.templateVersionLabelInput.value=template.versionLabel || '';
    q('template-signing-mode').value=template.signingMode || 'legacy'; q('template-require-additional-for-scribe').checked=!!template.requireAdditionalForScribe;
    Forms.renderFieldEditPanel(el.fieldEditPanel, null); showScreen('template-editor'); await FieldEditor.loadFromTemplate(template); updateScribeAdditionalSetting(); updatePageIndicator(); showToast('編集中の書式を復元しました。編集後に保存してください。');
  }

  function updateEditorFieldSummary() {
    const fields = FieldEditor.getPages().flatMap(page => page.fields);
    const count = fields.filter(field => field.type === 'signature').length;
    const checks = fields.filter(field => field.type === 'declaration_checkbox').length;
    let text = '書式全体の署名欄：' + count + 'つ ／ 確認チェック：' + checks + 'つ（署名者の人数には含みません）。';
    if (count > 1 && q('template-signing-mode').value === 'single') text += ' 署名欄が複数あるため、署名方法を「必要な場合だけ追加の人も署名」または「全員が署名する」に変更してください。';
    q('template-field-summary').textContent = text;
    const active = FieldEditor.getActiveSignatureField();
    q('field-assignment-target').textContent = active
      ? '次の署名者項目の割当先：署名欄 ' + active.signOrder + (active.label ? '（' + active.label + '）' : '') + '。別の人の項目を置くときは、その署名欄を押してください。'
      : '署名者の項目を置く前に、割り当てたい署名欄を押してください。利用者本人の氏名・住所は共通項目です。';
  }

  function updateScribeAdditionalSetting() {
    const visible = q('template-signing-mode').value === 'optional';
    q('scribe-additional-setting').style.display = visible ? '' : 'none';
    q('scribe-additional-hint').style.display = visible ? '' : 'none';
    updateEditorFieldSummary();
  }

  async function openTemplateForEditing(id) {
    const t = TemplateStore.get(id);
    if (!t) return;
    currentEditingTemplateId = t.id;
    currentPdfBase64 = t.pdfBase64;
    el.templateNameInput.value = t.name;
    el.templateVersionLabelInput.value = t.versionLabel || '';
    q('template-signing-mode').value = t.signingMode || 'legacy';
    q('template-require-additional-for-scribe').checked = !!t.requireAdditionalForScribe;
    updateScribeAdditionalSetting();
    Forms.renderFieldEditPanel(el.fieldEditPanel, null);
    showScreen('template-editor');
    showToast('PDFを読み込み中...', 15000);
    try {
      await withTimeout(FieldEditor.loadFromTemplate(t), 20000, 'PDFの読み込みがタイムアウトしました');
      updatePageIndicator();
      showToast('読み込みました', 1200);
    } catch (e) {
      console.error('PDFの読み込みに失敗しました', e);
      alert(PDF_LOAD_ERROR_MESSAGE + '\n\n' + e.message);
    }
  }

  function resetTemplateEditor() {
    currentEditingTemplateId = null;
    currentPdfBase64 = null;
    el.templateNameInput.value = '';
    el.templateVersionLabelInput.value = '';
    q('template-signing-mode').value = 'single';
    q('template-require-additional-for-scribe').checked = true;
    updateScribeAdditionalSetting();
    el.pdfFileInput.value = '';
    q('pdf-file-status').textContent='';
    Forms.renderFieldEditPanel(el.fieldEditPanel, null);
  }

  function chooseSigningModeBeforeSave(count) {
    const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop';
    const box = document.createElement('div'); box.className = 'signing-modal-box';
    const title = document.createElement('h3'); title.textContent = '署名欄が' + count + 'つあります。署名方法を選んでください';
    const note = document.createElement('p'); note.textContent = '現在の設定は「1人で完結する」です。確認チェックの数とは関係ありません。追加の署名欄を使う条件を選ぶと、その設定で保存します。';
    const choose = mode => { q('template-signing-mode').value = mode; updateScribeAdditionalSetting(); backdrop.remove(); saveCurrentTemplate(); };
    const optionalNote = document.createElement('p'); optionalNote.className = 'side-panel-hint';
    optionalNote.textContent = '本人の署名だけで完結でき、追加署名が必要な場合だけ次の欄を使います。' + (q('template-require-additional-for-scribe').checked ? '現在の設定では、家族が本人名を代筆した場合は家族本人の追加署名も必要です。' : '');
    box.append(title,note,bigButton('必要な場合だけ追加の人も署名して保存', () => choose('optional')),optionalNote,bigButton('全員の署名を必須にして保存', () => choose('all')),bigButton('編集に戻る', () => backdrop.remove(),true));
    backdrop.appendChild(box); document.body.appendChild(backdrop);
  }

  async function saveCurrentTemplate() {
    const name = el.templateNameInput.value.trim();
    if (!name) { alert('書式名を入力してください'); return; }
    if (!currentPdfBase64) { alert('PDFを選択してください'); return; }
    const pages = FieldEditor.getPages();
    const versionLabel = el.templateVersionLabelInput.value.trim();

    const signingMode = q('template-signing-mode').value;
    const signatureCount = pages.flatMap(page => page.fields).filter(field => field.type === 'signature').length;
    if (signingMode === 'single' && signatureCount > 1) { chooseSigningModeBeforeSave(signatureCount); return; }
    const requireAdditionalForScribe = signingMode === 'optional' && q('template-require-additional-for-scribe').checked;
    const errors = Models.validateTemplate({ pages, signingMode, requireAdditionalForScribe });
    if (errors.length) { alert('保存前に修正してください。\n' + errors.join('\n')); return; }

    // localStorageの保存容量超過(QuotaExceededError等)はここで必ず捕まえる。
    // 捕まえずに画面遷移まで進んでしまうと、実際には保存されていないのに保存完了したように
    // 見えてしまい、せっかく配置した署名欄の作業がまるごと消えてしまう
    let versionedFrom = null;
    q('btn-save-template').disabled = true;
    try {
      if (currentEditingTemplateId) {
        const existing = TemplateStore.get(currentEditingTemplateId);
        const updated = Object.assign({}, existing, { name, versionLabel, pdfBase64: currentPdfBase64, pages, signingMode, requireAdditionalForScribe });
        const saved = await TemplateStore.saveEdit(updated);
        currentEditingTemplateId = saved.id;
        versionedFrom = saved.versionedFrom || null;
      } else {
        const created = Models.createTemplate({ name, versionLabel, pdfBase64: currentPdfBase64, pages, signingMode, requireAdditionalForScribe });
        await TemplateStore.saveNew(created);
        currentEditingTemplateId = created.id;
      }
    } catch (e) {
      alert(e.message);
      return; // 保存失敗時は編集内容を画面に保持する。
    } finally { q('btn-save-template').disabled = false; }
    if (versionedFrom) {
      showToast('署名実績があるため新版(v' + (versionedFrom + 1) + ')として保存しました', 4000);
    } else {
      showToast('テンプレートを保存しました');
    }
    showScreen('home');
    renderHomeTemplateList();
  }

  function openSignatureTest(field) {
    const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop';
    const box = document.createElement('div'); box.className = 'signing-modal-box';
    const title = document.createElement('h3'); title.textContent = '署名欄 ' + field.signOrder + ' の記入テスト';
    const note = document.createElement('p'); note.textContent = '架空のお名前などで試し書きしてください。「書面で確認」で、この枠へ配置した結果を確認できます。契約やテンプレートには保存されません。';
    const tools = document.createElement('div'); tools.className = 'signature-tools';
    const canvas = document.createElement('canvas'); canvas.id = 'signature-test-canvas'; canvas.width = 700; canvas.height = 250;
    const status = document.createElement('p'); status.setAttribute('role','status');
    let pad;
    const close = () => { pad.destroy(); backdrop.remove(); };
    const check = bigButton('書面で確認', () => {
      FieldEditor.setSignaturePreview(field.id, pad.toDataUrl()); close(); previewTemplate(field.id);
    }); check.disabled = true;
    const undo = bigButton('1画戻す', () => pad.undo(), true);
    const clear = bigButton('全消去', () => { if (confirm('試し書きをすべて消しますか？')) pad.clear(); }, true);
    tools.append(undo,clear); box.append(title,note,tools,canvas,status,check,bigButton('閉じる',close,true));
    backdrop.appendChild(box); document.body.appendChild(backdrop);
    pad = SignaturePad.create(canvas, valid => { check.disabled = !valid; undo.disabled = clear.disabled = !pad.canUndo(); status.textContent = valid ? '書面での表示を確認できます。' : '枠内に試し書きしてください。点だけ・ごく小さい線では確認できません。'; });
    undo.disabled = clear.disabled = true;
  }

  async function previewTemplate(targetFieldId) {
    if (!currentPdfBase64) { alert('先にPDFを選択してください。'); return; }
    const button = q('btn-preview-template');
    button.disabled = true;
    let previewDoc = null;
    let backdrop = null;
    try {
      // 見本生成は本番の署名セッション・テンプレート保存を変更しない。
      const template = Models.createTemplate({ name: '印字見本', pdfBase64: currentPdfBase64,
        // 配置の見本は人数設定の途中でも確認可能にする。実際の書式の署名方法は変更しない。
        signingMode: 'legacy', requireAdditionalForScribe: false,
        pages: JSON.parse(JSON.stringify(FieldEditor.getPages())) });
      const name = q('preview-name').value.trim() || '山田 太郎';
      const role = q('preview-role').value;
      const sampleSignature = FieldEditor.getSignatureSample();
      const session = Models.createSigningSession({ recipientName: role === 'recipient' ? name : '利用者 見本', recipientAddress: q('preview-recipient-address').value, recipientBuilding: q('preview-recipient-building').value, status: 'completed',
        completedAt: new Date().toISOString(), templateVersion: template.version });
      const signatures = template.pages.flatMap(page => page.fields).filter(field => field.type === 'signature').sort((a,b) => a.signOrder - b.signOrder);
      session.signers = signatures.map((field, index) => Models.createSigner({
        fieldId: field.id, role: index === 0 ? role : 'additional', order: index + 1,
        typedName: index === 0 ? name : q('preview-additional-name').value.trim() || '山田 花子',
        address: q('preview-address').value, building: q('preview-building').value, relationship: index > 0 || role === 'family' ? '長女' : '',
        declarationChecked: role === 'family', signedAt: session.completedAt,
        signatureImageDataUrl: FieldEditor.getSignaturePreview(field.id) || sampleSignature,
      }));
      const bytes = await PdfWriter.buildSignedPdf(template, session, { preview: true });
      previewDoc = await PdfUtils.loadPdf(bytes.slice().buffer);
      backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      const box = document.createElement('div');
      box.className = 'signing-modal-box is-expanded';
      const title = document.createElement('h3'); title.textContent = '試し印字（見本）';
      const note = document.createElement('p');
      note.textContent = targetFieldId ? '試し書きした筆跡を、本番と同じ処理でこのページに配置しました。大きさや位置をご確認ください。閉じると枠のサイズを調整し、再度「試し印字を確認」で見られます。' : '設定した文字サイズ・住所の折り返し・署名の位置をPDFで確認してください。試し書きした欄にはその筆跡、それ以外の署名欄には見本を表示します。';
      const close = bigButton('閉じる', () => { backdrop.remove(); previewDoc.destroy(); }, true);
      const save = bigButton('見本PDFを保存', () => ExportModule.downloadBlob(bytes, '契約書_印字見本.pdf', 'application/pdf'), true);
      box.append(title, note, close, save);
      backdrop.append(box); document.body.append(backdrop);
      const targetPage = targetFieldId ? template.pages.findIndex(page => page.fields.some(field => field.id === targetFieldId)) + 1 : 0;
      for (let number = 1; number <= previewDoc.numPages; number++) {
        if (targetPage && number !== targetPage) continue;
        if (!backdrop.isConnected) break;
        const pageCanvas = document.createElement('canvas');
        pageCanvas.style.cssText = 'display:block;max-width:100%;height:auto;margin-top:16px;border:1px solid #bbb';
        box.append(pageCanvas);
        await PdfUtils.renderPageToCanvas(previewDoc, number, pageCanvas, 1.4);
      }
    } catch (e) {
      if (!backdrop || backdrop.isConnected) alert('試し印字を作成できませんでした。\n' + e.message);
      if (backdrop) backdrop.remove();
      if (previewDoc) previewDoc.destroy();
    } finally { button.disabled = false; }
  }

  // ===== 署名フロー画面 =====
  const ROLE_LABELS = { recipient: '利用者本人', family: 'ご家族（代筆・代理人）', additional: '追加の署名者', either: '署名者' };

  function renderSigningStep() {
    const stage = el.signingStage;
    stage.innerHTML = '';

    if (signingUiState.phase === 'recipient_name') {
      const mode = currentSigningTemplate.signingMode || 'legacy';
      const recipientAddressFields = currentSigningTemplate.pages.flatMap(page => page.fields).filter(field => field.type === 'recipient_address');
      const card = buildCard('署名前の確認（事業者用）', '<p>利用者氏名と、今回記入する方を確認してから端末をお渡しください。ご家族が代筆・代理署名する場合も利用者本人の情報は変わりません。</p>');
      const saveHint = document.createElement('p'); saveHint.className = 'side-panel-hint'; saveHint.textContent = '再読み込みや端末の終了に備え、区切りのよい時点で上の「途中保存（暗号化）」からファイルを保存してください。保存したファイルはホームの「途中保存ファイルから再開」で開けます。保存せず再読み込みすると入力は消えます。'; card.append(saveHint);
      const label = document.createElement('label');
      label.className = 'signing-field-label';
      label.textContent = '利用者名';
      const input = document.createElement('input');
      input.id = 'signing-recipient-name';
      input.type = 'text';
      input.placeholder = '例：介護 太郎';
      input.value = signingUiState.draft.recipientName || '';
      input.addEventListener('input', () => { signingUiState.draft.recipientName = input.value; });
      label.appendChild(input);
      card.appendChild(label);
      let recipientAddressInput = null;
      let recipientAddressHint = null;
      let recipientBuildingInput = null;
      if (recipientAddressFields.length) {
        const addressLabel = document.createElement('label'); addressLabel.className = 'signing-field-label';
        addressLabel.textContent = recipientAddressFields.some(field => field.required) ? '利用者住所（PDF印字用・必須）' : '利用者住所（PDF印字用・任意）';
        recipientAddressInput = document.createElement('input'); recipientAddressInput.id = 'signing-recipient-address';
        recipientAddressInput.type = 'text'; recipientAddressInput.placeholder = '例：〇〇市〇〇町1-2-3';
        recipientAddressInput.value = signingUiState.draft.recipientAddress || '';
        recipientAddressInput.addEventListener('input', () => { signingUiState.draft.recipientAddress = recipientAddressInput.value; });
        addressLabel.appendChild(recipientAddressInput); card.appendChild(addressLabel);
        const buildingLabel = document.createElement('label'); buildingLabel.className = 'signing-field-label';
        buildingLabel.textContent = '利用者の建物名・部屋番号（任意）';
        recipientBuildingInput = document.createElement('input'); recipientBuildingInput.id = 'signing-recipient-building';
        recipientBuildingInput.placeholder = '例：ケアマンションA棟101号室';
        recipientBuildingInput.value = signingUiState.draft.recipientBuilding || '';
        recipientBuildingInput.addEventListener('input', () => { signingUiState.draft.recipientBuilding = recipientBuildingInput.value; });
        buildingLabel.append(recipientBuildingInput); card.append(buildingLabel);
        recipientAddressHint = document.createElement('p'); recipientAddressHint.className = 'side-panel-hint';
        recipientAddressHint.textContent = '本人の住所として印字します。本人自署では引き継ぎ、家族が同じ住所なら署名時にコピーできます。';
        card.appendChild(recipientAddressHint);
      }
      const roleSelect = document.createElement('select');
      roleSelect.id = 'signing-primary-role';
        [['recipient','利用者本人が署名する'],['family','ご家族が署名・代筆する']].forEach(([value,text]) => {
        const option = document.createElement('option'); option.value = value; option.textContent = text; roleSelect.append(option);
      });
      roleSelect.value = signingUiState.draft.primaryRole || 'recipient';
      roleSelect.addEventListener('change', () => { signingUiState.draft.primaryRole = roleSelect.value; });
      const additionalSelect = document.createElement('select');
      additionalSelect.id = 'signing-additional-choice';
      [['','選択してください'],['no','今回は追加署名が不要'],['yes','追加署名も必要']].forEach(([value,text]) => {
        const option = document.createElement('option'); option.value = value; option.textContent = text; additionalSelect.append(option);
      });
      additionalSelect.value = signingUiState.draft.additionalChoice || '';
      additionalSelect.addEventListener('change', () => { signingUiState.draft.additionalChoice = additionalSelect.value; });
      if (mode !== 'legacy') {
        const roleLabel = document.createElement('label'); roleLabel.className = 'signing-field-label';
        roleLabel.append(document.createTextNode('最初に署名する方'),roleSelect); card.append(roleLabel);
        const summary = document.createElement('p');
        summary.textContent = mode === 'single' ? 'この書式は1人の署名で完了します。本人が署名する場合、家族の署名は求めません。'
          : '署名の順番：' + currentSigningTemplate.pages.flatMap(page => page.fields).filter(field => field.type === 'signature').sort((a,b) => a.signOrder-b.signOrder).map((field,index) => (index + 1) + '. ' + (field.label || (index === 0 ? '本人または家族' : '追加署名'))).join(' → ');
        card.append(summary);
        let additionalLabel = null;
        if (mode === 'optional') {
          additionalLabel = document.createElement('label'); additionalLabel.className = 'signing-field-label';
          additionalLabel.append(document.createTextNode('書面の目的に照らして、追加署名は必要ですか'),additionalSelect); card.append(additionalLabel);
        }
        const scribeAdditionalNote = document.createElement('p');
        scribeAdditionalNote.className = 'side-panel-hint';
        scribeAdditionalNote.textContent = 'この書式では、本人名を家族が代筆した場合、続けて同じご家族の署名も必要です。';
        card.append(scribeAdditionalNote);
        const capacityLabel = document.createElement('label'); capacityLabel.id = 'signing-family-capacity-label'; capacityLabel.className = 'signing-field-label';
        capacityLabel.append(document.createTextNode('ご家族が書く場合の方法'));
        const capacitySelect = document.createElement('select'); capacitySelect.id = 'signing-family-capacity';
        [['scribe','本人の意思を確認して代筆する'],['representative','権限を確認して代理人として署名する']].forEach(([value,text])=>{
          const option=document.createElement('option');option.value=value;option.textContent=text;capacitySelect.append(option);
        });
        capacitySelect.value = signingUiState.draft.primaryCapacity || 'scribe';
        capacitySelect.addEventListener('change', () => { signingUiState.draft.primaryCapacity = capacitySelect.value; });
        capacityLabel.appendChild(capacitySelect); card.append(capacityLabel);
        function scribeAdditionalRequired() {
          return mode === 'optional' && !!currentSigningTemplate.requireAdditionalForScribe &&
            roleSelect.value === 'family' && capacitySelect.value === 'scribe';
        }
        function updateFamilyCapacityVisibility(){
          capacityLabel.style.display=roleSelect.value==='family'?'':'none';
          const required = scribeAdditionalRequired();
          if (additionalLabel) additionalLabel.style.display = required ? 'none' : '';
          scribeAdditionalNote.style.display = required ? '' : 'none';
          if (recipientAddressHint) recipientAddressHint.textContent = roleSelect.value === 'family'
            ? '本人の住所として印字します。ご家族の住所が同じなら、署名時にコピーできます。'
            : '本人の住所として印字します。署名者住所欄がある場合は同じ住所を引き継ぎ、本人が訂正できます。';
        }
        roleSelect.addEventListener('change',updateFamilyCapacityVisibility);
        capacitySelect.addEventListener('change',updateFamilyCapacityVisibility);
        updateFamilyCapacityVisibility();
        const note = document.createElement('p'); note.className = 'side-panel-hint';
        note.textContent = 'この画面は事業者側が事前確認します。アプリが契約能力や代理権を判定するものではありません。'; card.append(note);
      }
      const nextBtn = bigButton('次へ進む', async () => {
        const plan = { recipientAddress: recipientAddressInput ? recipientAddressInput.value.trim() : '', recipientBuilding: recipientBuildingInput ? recipientBuildingInput.value.trim() : '', primaryRole: roleSelect.value,
          primaryCapacity: mode !== 'legacy' && roleSelect.value === 'family' ? q('signing-family-capacity').value : undefined,
          includeAdditional: mode === 'all' || (mode === 'optional' && currentSigningTemplate.requireAdditionalForScribe &&
            roleSelect.value === 'family' && q('signing-family-capacity').value === 'scribe') ? true
            : mode === 'optional' && !additionalSelect.value ? undefined : additionalSelect.value === 'yes' };
        nextBtn.disabled=true;
        try {
          await PdfWriter.prepareTextLayout();
          const fields=currentSigningTemplate.pages.flatMap(page=>page.fields);
          PdfWriter.assertTextFieldsFit(fields.filter(field=>['recipient_name','recipient_address'].includes(field.type)).map(field=>({field,text:field.type==='recipient_name'?input.value.trim():Models.fullAddress(plan.recipientAddress,plan.recipientBuilding)})));
          SigningFlow.startSession(currentSigningTemplate, input.value.trim(), signingUiState.resignOf, plan);
        }
        catch(e) { alert('署名前に印字を確認してください。入力は保持しています。\n'+e.message); return; }
        finally { nextBtn.disabled=false; }
        if (SigningFlow.isQueueComplete()) {
          signingUiState.phase = 'review';
        } else {
          signingUiState.phase = 'handoff';
          signingUiState.draft = {};
        }
        renderSigningStep();
      });
      card.appendChild(nextBtn);
      stage.appendChild(card);
      return;
    }

    if (signingUiState.phase === 'handoff') {
      const field = SigningFlow.getCurrentField();
      const progress = SigningFlow.getProgress();
      // 署名欄はテンプレート側で本人/家族を固定しないため、ここでは誰が署名するかまだ分からない
      // (次の署名モーダルでその場で選んでもらう)
      const card = buildCard('端末をお渡しください',
        '<p class="signing-progress">署名 '+ progress.current + ' / '+ progress.total + '</p>' +
        '<p>次に署名される方に端末をお渡しし、内容をご確認いただいた上で「続ける」を押してください。</p>');
      const continueWith = draft => {
        signingUiState.phase = 'document';
        signingUiState.draft = Object.assign({ typedName: '', address: '', building: '', relationship: '', declarationChecked: false }, signingUiState.restoredDraft ? signingUiState.draft : {}, draft);
        signingUiState.restoredDraft = false;
        if (signingUiState.docView) signingUiState.docView.pageIndex = null;
        renderSigningStep();
      };
      const reusableScribe = SigningFlow.getReusableScribeDetails();
      if (reusableScribe) {
        const note = document.createElement('p'); note.className = 'side-panel-hint';
        const previous = SigningFlow.getSession().signers.at(-1);
        const action = previous.signingCapacity === 'representative' ? '代理署名' : '代筆';
        note.textContent = '先ほど' + action + 'したご家族がご自身の欄にも署名する場合、氏名・住所・建物名・本人との関係・立場を引き継げます。確認・修正し、署名とこの欄の同意は改めてお願いします。';
        card.appendChild(note);
        card.appendChild(bigButton('先ほど' + action + 'したご家族が続けて署名', () => continueWith(reusableScribe)));
        if (!(currentSigningTemplate.requireAdditionalForScribe && previous.signingCapacity === 'scribe' && SigningFlow.getSession().signingMode === 'optional')) {
          card.appendChild(bigButton('別の方が署名', () => continueWith({})));
        }
      } else {
        card.appendChild(bigButton('続ける', () => continueWith({})));
      }
      // 必須にしていない署名欄は、今回は不要と判断してその場で終了できる
      // (例：本人の署名だけで契約が完結し、ご家族の署名は不要というケース)。
      // 「続ける」の陰に隠れる二次ボタンにせず、同じくらい選びやすい見た目にしておく
      if (!field.required && SigningFlow.getSession().signingMode === 'legacy') {
        const skipBtn = bigButton('ここで契約を終了する（この署名は不要）', () => {
          SigningFlow.skipCurrentField();
          if (SigningFlow.isQueueComplete()) {
            signingUiState.phase = 'review';
          } else {
            signingUiState.draft = { typedName: '', relationship: '', declarationChecked: false };
          }
          if (signingUiState.docView) signingUiState.docView.pageIndex = null;
          renderSigningStep();
        });
        skipBtn.classList.add('big-button-finish');
        card.appendChild(skipBtn);
      }
      stage.appendChild(card);
      return;
    }

    if (signingUiState.phase === 'document') {
      renderDocumentPhase(stage);
      return;
    }

    if (signingUiState.phase === 'review') {
      const session = SigningFlow.getSession();
      const recipientLine = session.recipientName
        ? '<p><strong>対象者: ' + escapeHtml(session.recipientName) + '様</strong></p>' : '';
      const card = buildCard('署名内容・交付方法の確認', recipientLine + '<p>以下の内容で契約を確定します。よろしければ「確定してPDFを作成」を押してください。</p>');
      if (session.eventLog.some(event => event.reason === 'additional_not_required')) {
        const note = document.createElement('p'); note.textContent = '追加署名：署名前に「今回は不要」と確認済み'; card.append(note);
      }
      session.signers.forEach((s, i) => {
        const row = document.createElement('div');
        row.className = 'signer-thumb-row';
        const img = document.createElement('img');
        img.src = s.signatureImageDataUrl;
        row.appendChild(img);
        const info = document.createElement('div');
        info.className = 'signer-thumb-info';
        info.classList.add('signing-address-summary');
        info.textContent = (ROLE_LABELS[s.role] || s.role) + '　' + s.typedName + (s.relationship ? '（続柄: ' + s.relationship + '）' : '') + (s.address ? '　住所: ' + Models.fullAddress(s.address,s.building) : '') + '　記入方法: ' + ({self:'本人自署',scribe:'本人の意思による代筆',representative:'代理人署名',additional:'追加の署名'}[s.signingCapacity] || '従来の記録');
        row.appendChild(info);
        // この人以降を取り直すことで、同意後に情報だけを書き換えない。
        {
          const redoRowBtn = document.createElement('button');
          redoRowBtn.type = 'button';
          redoRowBtn.className = 'tool-button-small';
          redoRowBtn.textContent = 'この署名をやり直す';
          redoRowBtn.addEventListener('click', () => {
            if (signingBusy) return;
            if (!confirm('この人以降の署名を取り消して、内容を確認し署名を取り直しますか？')) return;
            SigningFlow.redoSignerFrom(s.fieldId);
            signingUiState.previewConfirmed = false;
            signingUiState.phase = 'handoff';
            signingUiState.draft = {};
            if (signingUiState.docView) signingUiState.docView.pageIndex = null;
            renderSigningStep();
          });
          row.appendChild(redoRowBtn);
        }
        card.appendChild(row);
      });
      if (session.signers.length === 0) {
        // 唯一の署名欄が任意(必須OFF)で、その場でスキップされた場合にここへ来る。
        // 署名者ゼロのまま「署名済みPDF」を作れてしまうと信頼性の根幹に関わるため、明確に止める
        const warn = document.createElement('p');
        warn.className = 'side-panel-hint';
        warn.textContent = '署名者が1人もいないため、契約を確定できません。ホームに戻ってやり直してください。';
        card.appendChild(warn);
        const homeBtn = bigButton('ホームに戻る', () => { showScreen('home'); renderHomeTemplateList(); }, true);
        card.appendChild(homeBtn);
      } else {
        addReviewControls(card, session);
        // 連打で二重にPDFが作られる(重複ダウンロード)のを防ぐため、押した瞬間に無効化する。
        // 失敗した場合だけ再度押せるように戻す(finalizeSigning側でreturnする経路)
        const finalizeBtn = bigButton('確定してPDFを作成', () => {
          if (!reviewReady()) return;
          finalizeBtn.disabled = true;
          finalizeSigning().finally(() => { finalizeBtn.disabled = false; });
        });
        finalizeBtn.id = 'btn-finalize-signing';
        finalizeBtn.disabled = !reviewReady();
        card.appendChild(finalizeBtn);
      }
      stage.appendChild(card);
      return;
    }

    if (signingUiState.phase === 'done') {
      renderCompletedExport();
      return;
    }
  }

  function reviewReady() {
    const review = signingUiState.review;
    return !!(review && review.providerName.trim() && review.staffName.trim() &&
      (review.method !== 'electronic' || review.electronicConsent) && signingUiState.previewConfirmed);
  }

  function openDraftDialog(restore) {
    if (signingBusy) return;
    if (!restore && !hasPendingSigning()) { alert('途中保存する契約がありません。'); return; }
    const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop';
    const box = document.createElement('div'); box.className = 'signing-modal-box draft-dialog';
    const title = document.createElement('h3'); title.textContent = restore ? '途中保存ファイルから再開' : '途中保存（暗号化）';
    const note = document.createElement('p');
    note.textContent = restore ? '「契約途中保存」で始まるファイルとパスワードを指定します。最後に手動保存した時点から再開します。以前の.keiyakuファイルも選べます。'
      : '確定済みの署名と入力をパスワード付きファイルへ保存します。編集中の手書き署名は先に確定してください。パスワードを忘れると復元できません。';
    box.append(title,note);
    let fileInput = null;
    if (restore) {
      const label = document.createElement('label'); label.className = 'signing-field-label'; label.textContent = '暗号化した途中保存ファイル';
      fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.id = 'draft-restore-file';
      // iPadで未登録拡張子の旧ファイルも選べるよう、型フィルターを設けず復号時に内容を検証する。
      label.append(fileInput); box.append(label);
    }
    const passwordLabel = document.createElement('label'); passwordLabel.className = 'signing-field-label'; passwordLabel.textContent = '途中保存用パスワード';
    const password = document.createElement('input'); password.type = 'password'; password.autocomplete = restore ? 'current-password' : 'new-password';
    passwordLabel.append(password); box.append(passwordLabel);
    let repeat = null;
    if (!restore) {
      const label = document.createElement('label'); label.className = 'signing-field-label'; label.textContent = 'パスワードをもう一度';
      repeat = document.createElement('input'); repeat.type = 'password'; repeat.autocomplete = 'new-password'; label.append(repeat); box.append(label);
    }
    const status = document.createElement('p'); status.setAttribute('role','status'); box.append(status);
    const close = () => { password.value = ''; if (repeat) repeat.value = ''; backdrop.remove(); };
    const cancel = bigButton('閉じる',close,true);
    const submit = bigButton(restore ? '復元して再開' : '暗号化して保存',async () => {
      if (password.value.length < 12) { status.textContent = 'パスワードは12文字以上にしてください。'; return; }
      if (!restore && password.value !== repeat.value) { status.textContent = '二つのパスワードが一致しません。'; return; }
      submit.disabled = true; cancel.disabled = true; signingBusy = true;
      try {
        if (restore) {
          const file = fileInput.files[0];
          if (!file || file.size > 56*1024*1024) throw new Error('56MB以下の途中保存ファイルを選択してください。');
          const state = await DraftVault.decrypt(await file.text(),password.value);
          if (!state || state.format !== 'keiyaku-draft-state' || state.version !== 1 || !state.template || !state.ui ||
              !['recipient_name','handoff','document','review'].includes(state.ui.phase)) throw new Error('途中保存の契約データの形式が正しくありません。');
          const errors = Models.validateTemplate(state.template); if (errors.length) throw new Error(errors.join('\n'));
          if (state.flow) {
            SigningFlow.validateState(state.flow);
            if (JSON.stringify(state.template) !== JSON.stringify(state.flow.template)) throw new Error('途中保存の書式が署名記録と一致しません。');
          } else if (state.ui.phase !== 'recipient_name') throw new Error('途中の署名工程が欠落しています。');
          const pdf = await PdfUtils.loadPdf(PdfUtils.base64ToArrayBuffer(state.template.pdfBase64));
          try {
            if (pdf.numPages !== state.template.pages.length) throw new Error('途中保存のPDFページ数が一致しません。');
            for (let index=0; index<pdf.numPages; index++) {
              const size = await PdfUtils.getPageSize(pdf,index+1), page = state.template.pages[index];
              if (Math.abs(size.widthPt-page.widthPt)>0.1 || Math.abs(size.heightPt-page.heightPt)>0.1) throw new Error('途中保存のPDF寸法が一致しません。');
            }
          } finally { pdf.destroy(); }
          let audio = null;
          if (state.audio) {
            if (!['audio/webm','audio/mp4','audio/ogg'].some(type => String(state.audio.type).startsWith(type))) throw new Error('途中保存の録音形式が未対応です。');
            audio = new Blob([DraftVault.fromBase64(state.audio.bytes)],{type:state.audio.type});
          }
          if ((hasPendingSigning() || completedExport && !completedExport.confirmed) && !confirm('今の契約データを破棄し、途中保存した契約へ戻りますか？')) return;
          if (state.flow) SigningFlow.restoreState(state.flow);
          currentSigningTemplate = state.template; completedExport = null; sessionAudioBlob = audio;
          const phase = state.flow ? SigningFlow.isQueueComplete() ? 'review' : 'handoff' : 'recipient_name';
          signingUiState = {phase,restoredDraft:true,draft:state.ui.draft || {},review:state.ui.review,resignOf:state.ui.resignOf || null,previewConfirmed:false};
          q('btn-nav-resume').classList.remove('hidden'); q('btn-nav-draft-save').classList.remove('hidden'); q('btn-nav-last-export').classList.add('hidden');
          signingBusy = false; close(); showScreen('signing'); renderSigningStep(); showToast('途中保存した時点から再開しました');
        } else {
          const state = {format:'keiyaku-draft-state',version:1,template:currentSigningTemplate,
            flow:signingUiState.phase === 'recipient_name' ? null : SigningFlow.exportState(),
            ui:{phase:signingUiState.phase,draft:signingUiState.draft,review:signingUiState.review,resignOf:signingUiState.resignOf},
            audio:sessionAudioBlob ? {type:sessionAudioBlob.type,bytes:DraftVault.toBase64(new Uint8Array(await sessionAudioBlob.arrayBuffer()))} : null};
          const encrypted = await DraftVault.encrypt(state,password.value);
          const save = bigButton('途中保存ファイルを端末へ保存', () => {
            try { ExportModule.downloadBlob(new TextEncoder().encode(encrypted),'契約途中保存_'+Date.now()+'.json','application/json'); status.textContent = '保存操作を開始しました。保存先を確認してください。パスワードとファイルを両方保管してください。'; }
            catch(e) { status.textContent = '保存できませんでした。もう一度保存してください。' + e.message; }
          });
          // 暗号化の待ち時間でiPadのタップ権限が切れないよう、保存は別の明示操作にする。
          submit.hidden = true; password.value = ''; repeat.value = ''; password.disabled = true; repeat.disabled = true;
          box.insertBefore(save,cancel); status.textContent = '暗号化できました。下のボタンで端末に保存してください。';
        }
      } catch(e) { status.textContent = e.message; }
      finally { submit.disabled = false; cancel.disabled = false; signingBusy = false; }
    });
    box.append(submit,cancel); backdrop.append(box); document.body.append(backdrop);
  }

  function addReviewControls(card, session) {
    const review = signingUiState.review || (signingUiState.review = {
      providerName: OperatorSettings.load().providerName, staffName: '', method: 'paper', electronicConsent: false,
    });
    const address = document.createElement('p');
    address.classList.add('signing-address-summary');
    address.textContent = '利用者住所: ' + (Models.fullAddress(session.recipientAddress,session.recipientBuilding) || '書式で入力不要'); card.append(address);
    function update() {
      signingUiState.previewConfirmed = false;
      const button = q('btn-finalize-signing'); if (button) button.disabled = true;
    }
    const registered = OperatorSettings.load();
    const staffChoiceLabel = document.createElement('label'); staffChoiceLabel.className = 'signing-field-label';
    staffChoiceLabel.textContent = '登録した担当者を選ぶ';
    const staffChoice = document.createElement('select'); staffChoice.id = 'review-staff-choice';
    [['','担当者を選択してください'],...registered.staffNames.map(name => [name,name]),['__manual__','直接入力する']].forEach(([value,text]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = text; staffChoice.append(option);
    });
    staffChoice.value = registered.staffNames.includes(review.staffName) ? review.staffName : review.staffName || !registered.staffNames.length ? '__manual__' : '';
    staffChoiceLabel.append(staffChoice);
    const reviewerLabels = {};
    ['providerName','staffName'].forEach((key, index) => {
      const label = document.createElement('label'); label.className = 'signing-field-label';
      label.textContent = index ? '説明・確認した担当者名' : '事業所名';
      const input = document.createElement('input'); input.value = review[key];
      input.addEventListener('input', () => { review[key] = input.value; update(); });
      label.append(input); card.append(label); reviewerLabels[key] = label;
      if (key === 'staffName') {
        input.id = 'review-staff-input'; card.insertBefore(staffChoiceLabel,label);
        label.hidden = staffChoice.value !== '__manual__';
      }
    });
    staffChoice.addEventListener('change', () => {
      review.staffName = staffChoice.value === '__manual__' ? '' : staffChoice.value;
      q('review-staff-input').value = review.staffName; reviewerLabels.staffName.hidden = staffChoice.value !== '__manual__'; update();
    });
    const methodLabel = document.createElement('label'); methodLabel.className = 'signing-field-label';
    methodLabel.textContent = '控えの交付方法';
    const method = document.createElement('select');
    [['paper','紙で渡す'],['electronic','電子ファイルで渡す']].forEach(([value,text]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = text; method.append(option);
    });
    method.value = review.method; methodLabel.append(method); card.append(methodLabel);
    const consentLabel = document.createElement('label'); consentLabel.className = 'checkbox-row';
    const consent = document.createElement('input'); consent.type = 'checkbox'; consent.checked = review.electronicConsent;
    consentLabel.append(consent, document.createTextNode('電子交付の方法を説明し、受け取る方の承諾を得ました')); card.append(consentLabel);
    consentLabel.hidden = method.value !== 'electronic';
    method.addEventListener('change', () => { review.method = method.value; review.electronicConsent = false; consent.checked = false; consentLabel.hidden = method.value !== 'electronic'; update(); });
    consent.addEventListener('change', () => { review.electronicConsent = consent.checked; update(); });
    const hint = document.createElement('p'); hint.className = 'side-panel-hint';
    hint.textContent = '完成書面を確認してから確定します。控えを実際に渡した結果は、確定後に別の交付記録へ保存できます。担当者名は事業者の申告による記録です。'; card.append(hint);
    const preview = bigButton('完成書面を確認', async () => {
      if (!review.providerName.trim() || !review.staffName.trim()) { alert('事業所名と説明・確認した担当者名を入力してください。'); return; }
      if (review.method === 'electronic' && !review.electronicConsent) { alert('電子交付の方法を説明し、受け取る方の承諾を確認してください。'); return; }
      preview.disabled = true;
      signingBusy = true;
      const reviewKey = JSON.stringify(review);
      let doc = null, backdrop = null;
      try {
        const snapshot = JSON.parse(JSON.stringify(session));
        snapshot.operator = {providerName: review.providerName.trim(), staffName: review.staffName.trim()};
        snapshot.deliveryPlan = {method: review.method, electronicConsent: review.method === 'electronic' && review.electronicConsent};
        const bytes = await PdfWriter.buildSignedPdf(currentSigningTemplate, snapshot);
        doc = await PdfUtils.loadPdf(bytes.slice().buffer);
        backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop';
        const box = document.createElement('div'); box.className = 'signing-modal-box is-expanded final-preview';
        const title = document.createElement('h3'); title.textContent = '完成書面の確認（確定前）';
        const note = document.createElement('p'); note.textContent = '氏名・住所・署名・チェックと印字の収まりを全ページ確認してください。確定時に署名完了時刻が記録ページへ反映されます。';
        const close = bigButton('戻る', () => { backdrop.remove(); doc.destroy(); }, true);
        const confirm = bigButton('印字内容を確認しました', () => {
          if (JSON.stringify(review) !== reviewKey) { alert('確認内容が変わりました。完成書面をもう一度表示してください。'); backdrop.remove(); doc.destroy(); return; }
          signingUiState.previewConfirmed = true; q('btn-finalize-signing').disabled = !reviewReady();
          backdrop.remove(); doc.destroy();
        });
        confirm.disabled = true; box.append(title, note, close); backdrop.append(box); document.body.append(backdrop);
        for (let number = 1; number <= doc.numPages; number++) {
          if (!backdrop.isConnected) return;
          const canvas = document.createElement('canvas'); canvas.style.cssText = 'display:block;max-width:100%;height:auto;margin:16px 0;border:1px solid #bbb';
          box.append(canvas); await PdfUtils.renderPageToCanvas(doc, number, canvas, 1.2);
        }
        box.append(confirm); confirm.disabled = false;
      } catch (e) {
        if (backdrop) backdrop.remove(); if (doc) doc.destroy();
        alert('完成書面を表示できませんでした。入力は保持しています。\n' + e.message);
      } finally { preview.disabled = false; signingBusy = false; }
    });
    card.append(preview);
    card.append(bigButton('利用者情報から確認し直す（全署名を取り直す）', () => {
      if (signingBusy) return;
      if (!confirm('全員の署名を取り直します。利用者情報の確認から始めますか？')) return;
      signingUiState = {phase:'recipient_name', draft:{recipientName:session.recipientName, recipientAddress:session.recipientAddress, recipientBuilding:session.recipientBuilding}, resignOf:session.resignOf};
      renderSigningStep();
    }, true));
  }

  function appendFileActions(container, getFile, label, probeFile) {
    const actions = document.createElement('div'); actions.className = 'file-actions';
    const status = document.createElement('p'); status.setAttribute('role','status');
    actions.append(bigButton(label + 'を保存', () => {
      try { const file=getFile(); if (!file) return; ExportModule.downloadBlob(file.bytes,file.name,file.mimeType); status.textContent='保存操作を開始しました。保存先でファイルを開いて確認してください。'; }
      catch(error) { status.textContent='保存を開始できませんでした。再試行してください。 '+error.message; }
    }));
    // 完成ファイルで共有対応を確認。交付記録は操作時に最新内容を生成する。
    if (ExportModule.canShareFile(probeFile || {bytes:new Uint8Array([32]),name:label+(label==='署名済みPDF'?'.pdf':'.json'),mimeType:label==='署名済みPDF'?'application/pdf':'application/json'})) {
      const share = bigButton(label + 'を共有', async () => {
        try { const file=getFile(); if (!file) return; share.disabled=true; await ExportModule.shareFile(file); status.textContent='共有先へファイルを渡しました。共有先で内容と保存結果を確認してください。'; }
        catch(error) { status.textContent=error.name==='AbortError'?'共有されませんでした。必要なら保存ボタンをご利用ください。':'共有できませんでした。保存ボタンからファイルを保存してください。 '+error.message; }
        finally { share.disabled=false; }
      },true); actions.append(share);
    }
    container.append(actions,status);
  }

  function addDeliveryRecord(card, saved) {
    const session = SigningFlow.getSession();
    const draft = saved.deliveryDraft || (saved.deliveryDraft = {recipient:'', status:'pending', detail:''});
    const title = document.createElement('h3'); title.textContent = '利用者への控えの交付'; card.append(title);
    const note = document.createElement('p'); note.textContent = '事業所への保存と、利用者への交付は別です。紙または電子で渡した結果を記録してください。記録はPDF・監査記録と一緒に保管します。'; card.append(note);
    [['recipient','控えを渡した相手'],['detail','交付方法の詳細・未交付の理由']].forEach(([key,text]) => {
      const label = document.createElement('label'); label.className = 'signing-field-label'; label.textContent = text;
      const input = document.createElement('input'); input.value = draft[key];
      input.addEventListener('input', () => { draft[key] = input.value; saved.confirmed = false; q('export-saved-confirm').checked = false; }); label.append(input); card.append(label);
    });
    const label = document.createElement('label'); label.className = 'signing-field-label'; label.textContent = '交付結果';
    const select = document.createElement('select');
    [['pending','まだ渡していない'],['delivered','控えを渡した']].forEach(([value,text]) => {const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option);});
    select.value = draft.status; select.addEventListener('change', () => {draft.status = select.value; saved.confirmed = false; q('export-saved-confirm').checked = false;}); label.append(select); card.append(label);
    appendFileActions(card, () => {
      if (draft.status === 'delivered' && !draft.recipient.trim()) { alert('控えを渡した相手を入力してください。'); return null; }
      const key=JSON.stringify(draft);
      if (saved.deliveryKey !== key) {
        saved.deliveryRecord={format:'keiyaku-delivery',schemaVersion:1,verificationId:session.verificationId,finalPdfHashSha256:session.finalPdfHashSha256,
          recordedAt:new Date().toISOString(),timeSource:'device_clock',operator:session.operator,method:session.deliveryPlan.method,
          electronicConsent:session.deliveryPlan.electronicConsent,recipient:draft.recipient.trim(),status:draft.status,detail:draft.detail.trim()}; saved.deliveryKey=key;
      }
      return {bytes:new TextEncoder().encode(JSON.stringify(saved.deliveryRecord,null,2)),name:saved.artifacts.fileNameBase+'_交付記録.json',mimeType:'application/json'};
    }, '交付記録');
  }

  function renderCompletedExport() {
    if (!completedExport) return;
    const saved = completedExport;
    const card = buildCard('署名書類ができました',
      '<p>下のボタンから、一つずつファイルを保存、または共有してください。保存先でファイルを開き、内容をご確認ください。</p>' +
      '<p>ブラウザのタブを閉じたり再読み込みすると、再保存できなくなります。次の署名を始めるまでは「直前の署名書類」から戻れます。</p>');
    const auditHint = document.createElement('p');
    auditHint.textContent = '契約内容と署名の記録はPDFで読めます。監査記録（JSON）はPDFと一緒に保管する照合用データです。「保存したファイルを照合する」から確認できます。';
    card.append(auditHint);
    const shareHint = document.createElement('p'); shareHint.className = 'side-panel-hint';
    shareHint.textContent = '「共有」は対応するファイルにだけ表示されます。共有先は端末で選びます。共有操作の後も保存先で内容を確認してください。'; card.append(shareHint);
    ExportModule.listArtifactFiles(saved.artifacts).forEach(file => {
      const name = document.createElement('p'); name.className = 'signing-filename'; name.textContent = file.name;
      card.append(name); appendFileActions(card, () => file, file.label, file);
    });
    const label = document.createElement('label');
    label.className = 'checkbox-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'export-saved-confirm';
    checkbox.checked = saved.confirmed;
    checkbox.addEventListener('change', () => { saved.confirmed = checkbox.checked; });
    label.append(checkbox, document.createTextNode(saved.artifacts.audioBytes
      ? 'PDFと音声を開いて確認し、監査記録も保存しました'
      : 'PDFを開いて確認し、監査記録も保存しました'));
    card.appendChild(label);
    addDeliveryRecord(card, saved);
    card.appendChild(bigButton('保存したファイルを照合する', () => showScreen('verification'), true));
    card.appendChild(bigButton('ホームに戻る', () => { showScreen('home'); renderHomeTemplateList(); }, true));
    el.signingStage.replaceChildren(card);
  }

  function findFieldPageIndex(template, fieldId) {
    return template.pages.findIndex(p => p.fields.some(f => f.id === fieldId));
  }

  // 文書プレビュー画面: 実際のPDFを表示し、今から署名する欄をハイライトする。
  // タップするとその場で署名モーダルが開く(field_editor.jsと同じPdfUtilsの描画を流用)。
  async function renderDocumentPhase(stage) {
    const field = SigningFlow.getCurrentField();
    const progress = SigningFlow.getProgress();

    const card = buildCard('書面を確認して署名してください',
      '<p class="signing-progress">署名 '+ progress.current + ' / '+ progress.total + '</p>' +
      '<p>契約内容をご確認いただき、下の書式内でハイライトされた署名欄をタップしてください。</p>');


    const wrap = document.createElement('div');
    wrap.className = 'signing-doc-wrap';
    const docStage = document.createElement('div');
    docStage.className = 'signing-doc-stage';
    const canvas = document.createElement('canvas');
    const overlay = document.createElement('div');
    overlay.className = 'signing-field-overlay';
    docStage.appendChild(canvas);
    docStage.appendChild(overlay);
    wrap.appendChild(docStage);
    card.appendChild(wrap);

    const nav = document.createElement('div');
    nav.className = 'signing-doc-nav';
    card.appendChild(nav);

    stage.appendChild(card);

    if (!signingUiState.docView) signingUiState.docView = { pdfDoc: null, pageIndex: null };
    const docView = signingUiState.docView;

    try {
      if (!docView.pdfDoc) {
        const bytes = PdfUtils.base64ToArrayBuffer(currentSigningTemplate.pdfBase64);
        docView.pdfDoc = await PdfUtils.loadPdf(bytes);
      }
      if (docView.pageIndex == null) {
        const targetPage = findFieldPageIndex(currentSigningTemplate, field.id);
        docView.pageIndex = targetPage >= 0 ? targetPage : 0;
      }
      // 別ページに切り替わっている間に署名が完了していたら描画を中断する(連打対策)
      if (signingUiState.phase !== 'document') return;

      const pageDef = currentSigningTemplate.pages[docView.pageIndex];
      const availWidth = Math.max((wrap.clientWidth || 560) - 24, 200);
      const scale = Math.max(availWidth / pageDef.widthPt, 0.3);
      await PdfUtils.renderPageToCanvas(docView.pdfDoc, docView.pageIndex + 1, canvas, scale);
      if (signingUiState.phase !== 'document') return;

      overlay.style.width = canvas.width + 'px';
      overlay.style.height = canvas.height + 'px';
      renderDocPageOverlay(overlay, pageDef, scale, field);

      if (currentSigningTemplate.pages.length > 1) {
        renderDocNav(nav, docView, currentSigningTemplate.pages.length);
      }
    } catch (e) {
      console.error('文書の表示に失敗しました', e);
      const errP = document.createElement('p');
      errP.textContent = '文書の表示に失敗しました。';
      card.appendChild(errP);
    }
  }

  function renderDocPageOverlay(overlay, pageDef, scale, activeField) {
    overlay.innerHTML = '';
    const session = SigningFlow.getSession();
    pageDef.fields.forEach(pageField => {
      const rect = PdfUtils.pdfRectToPixel(pageField, pageDef.heightPt, scale);
      if (pageField.id === activeField.id) {
        const box = document.createElement('div');
        box.className = 'signing-field-highlight';
        box.style.left = rect.left + 'px';
        box.style.top = rect.top + 'px';
        box.style.width = rect.width + 'px';
        box.style.height = rect.height + 'px';
        const tag = document.createElement('span');
        tag.className = 'signing-field-tag';
        tag.textContent = 'タップして署名';
        box.appendChild(tag);
        box.addEventListener('click', openSignatureModal);
        overlay.appendChild(box);
        return;
      }
      if (pageField.type !== 'signature') return;
      const signedEntry = session.signers.find(s => s.fieldId === pageField.id);
      if (!signedEntry) return;
      const img = document.createElement('img');
      img.className = 'signing-field-stamp';
      img.src = signedEntry.signatureImageDataUrl;
      img.style.left = rect.left + 'px';
      img.style.top = rect.top + 'px';
      img.style.width = rect.width + 'px';
      img.style.height = rect.height + 'px';
      overlay.appendChild(img);
    });
  }

  function renderDocNav(nav, docView, pageCount) {
    nav.innerHTML = '';
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'tool-button-small';
    prevBtn.textContent = '◀ 前のページ';
    prevBtn.disabled = docView.pageIndex <= 0;
    prevBtn.addEventListener('click', () => { docView.pageIndex -= 1; renderSigningStep(); });
    const label = document.createElement('span');
    label.className = 'signing-doc-page-label';
    label.textContent = (docView.pageIndex + 1) + ' / ' + pageCount;
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'tool-button-small';
    nextBtn.textContent = '次のページ ▶';
    nextBtn.disabled = docView.pageIndex >= pageCount - 1;
    nextBtn.addEventListener('click', () => { docView.pageIndex += 1; renderSigningStep(); });
    nav.appendChild(prevBtn);
    nav.appendChild(label);
    nav.appendChild(nextBtn);
  }

  // currentSigningTemplateの全ページから、今署名中の署名欄(linkedSignatureFieldId)に
  // 紐付き、かつ指定した役割・種類に一致するフィールドを集める。
  // 署名欄が複数あるテンプレートで、別の署名欄向けの確認チェック欄まで拾ってしまう事故を
  // 防ぐため、役割だけでなく紐付け(linkedFieldId)でも絞り込む
  function findTemplateFieldsForRole(role, types, linkedSignatureFieldId) {
    return Models.getSignerFields(currentSigningTemplate, linkedSignatureFieldId, role, types);
  }

  // 文書上のハイライトされた署名欄をタップした時に開くモーダル。
  // 名前・住所・続柄・代理権限チェック・事業所が配置した確認チェック欄・署名パッドをまとめてここで完結させる。
  async function openSignatureModal() {
    try { await PdfWriter.prepareTextLayout(); } catch(error) { alert('印字の確認を準備できませんでした。署名は始めていません。 '+error.message); return; }
    const field = SigningFlow.getCurrentField();

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'signing-modal-box';

    const title = document.createElement('h3');
    title.textContent = 'お名前を署名してください';
    box.appendChild(title);

    // 署名欄は役割をテンプレート側で固定しない設計のため、まず必ずどちらの立場で
    // 署名するかを選んでもらう。これによって続柄欄・代理権限チェック・確認チェック欄の表示が動的に切り替わる。
    // プルダウンだと選択に手間取るため、タップ一発で選べる二択ボタンにする(タブレット操作前提のため)
    const roleLabel = document.createElement('div');
    roleLabel.className = 'signing-field-label';
    roleLabel.textContent = 'どなたが記入しますか';
    box.appendChild(roleLabel);

    const roleToggle = document.createElement('div');
    roleToggle.className = 'signing-role-toggle';
    const plannedRole = SigningFlow.getPlannedRole();
    let selectedRole = plannedRole || 'recipient';
    const plannedCapacity = SigningFlow.getPlannedCapacity();
    let selectedCapacity = plannedCapacity || (selectedRole === 'family' ? 'representative' : selectedRole === 'additional' ? 'additional' : 'self');
    const roleToggleButtons = {};
    [['recipient', '利用者本人'], ['family', 'ご家族（代筆・代理）']].forEach(([value, text]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'signing-role-toggle-btn';
      btn.textContent = text;
      btn.addEventListener('click', () => {
        selectedRole = value;
        selectedCapacity = value === 'family' ? 'representative' : 'self';
        capacitySelect.value = selectedCapacity;
        nameLabelText.textContent = value === 'family' ? '実際に記入するご家族のお名前' : 'お名前';
        nameInput.value = value === 'recipient' ? recipientName : '';
        addressInput.value = value === 'recipient' ? recipientAddress : '';
        buildingInput.value = value === 'recipient' ? SigningFlow.getSession().recipientBuilding || '' : '';
        relInput.value = '';
        Object.values(roleToggleButtons).forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        rebuildDynamicSections();
      });
      roleToggle.appendChild(btn);
      roleToggleButtons[value] = btn;
    });
    if (roleToggleButtons[selectedRole]) roleToggleButtons[selectedRole].classList.add('is-active');
    box.appendChild(roleToggle);
    if (plannedRole) {
      roleToggle.style.display = 'none';
      roleLabel.textContent = '署名する立場：' + ROLE_LABELS[plannedRole];
    }

    function currentRole() { return selectedRole; }

    const capacityLabel = document.createElement('label');
    capacityLabel.className = 'signing-field-label';
    capacityLabel.textContent = 'ご家族が記入する方法';
    const capacitySelect = document.createElement('select');
    [['scribe','本人の意思を確認して本人名を代筆'],['representative','代理権を確認して代理人として署名']].forEach(([value,text])=>{
      const option=document.createElement('option');option.value=value;option.textContent=text;capacitySelect.append(option);
    });
    capacitySelect.value = selectedCapacity === 'scribe' ? 'scribe' : 'representative';
    capacitySelect.addEventListener('change',()=>{ selectedCapacity=capacitySelect.value; rebuildDynamicSections(); });
    capacityLabel.appendChild(capacitySelect);
    box.appendChild(capacityLabel);
    if (plannedCapacity) capacityLabel.style.display = 'none';

    const nameLabel = document.createElement('label');
    nameLabel.className = 'signing-field-label';
    const nameLabelText = document.createElement('span');
    nameLabelText.textContent = currentRole() === 'family' ? '実際に記入するご家族のお名前' : 'お名前';
    nameLabel.appendChild(nameLabelText);
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    // 利用者本人が署名する場合は最初に入力した利用者名をそのまま流用する(二重入力の手間を省く)。
    // ご家族代理の場合は別人の可能性があるため空欄のまま、そのつど入力してもらう。
    const recipientName = SigningFlow.getSession().recipientName || '';
    nameInput.value = signingUiState.draft.typedName
      || (currentRole() === 'recipient' ? recipientName : '');
    nameInput.readOnly = plannedRole === 'recipient' ||
      (!!currentSigningTemplate.requireAdditionalForScribe && !!SigningFlow.getReusableScribeDetails());
    nameLabel.appendChild(nameInput);
    box.appendChild(nameLabel);
    const nameHint=document.createElement('p'); nameHint.className='side-panel-hint'; nameHint.id='scribe-name-hint'; box.append(nameHint);

    const addressLabel = document.createElement('label');
    addressLabel.className = 'signing-field-label';
    const addressLabelText = document.createElement('span');
    addressLabel.appendChild(addressLabelText);
    const addressInput = document.createElement('input');
    addressInput.type = 'text';
    addressInput.placeholder = '例：〇〇市〇〇町1-2-3';
    const recipientAddress = SigningFlow.getSession().recipientAddress || '';
    addressInput.value = signingUiState.draft.address || (currentRole() === 'recipient' ? recipientAddress : '');
    addressLabel.appendChild(addressInput);
    box.appendChild(addressLabel);
    const buildingLabel = document.createElement('label'); buildingLabel.className = 'signing-field-label';
    buildingLabel.textContent = '記入者の建物名・部屋番号（任意）';
    const buildingInput = document.createElement('input'); buildingInput.placeholder = '例：ケアマンションA棟101号室';
    buildingInput.value = signingUiState.draft.building || (currentRole() === 'recipient' ? SigningFlow.getSession().recipientBuilding || '' : '');
    buildingLabel.append(buildingInput); box.append(buildingLabel);
    const copyRecipientAddressBtn = document.createElement('button');
    copyRecipientAddressBtn.type = 'button';
    copyRecipientAddressBtn.className = 'tool-button-small';
    copyRecipientAddressBtn.textContent = '利用者本人と同じ住所を入力';
    const copyAddressHint = document.createElement('p');
    copyAddressHint.className = 'side-panel-hint';
    copyRecipientAddressBtn.addEventListener('click', () => {
      addressInput.value = recipientAddress;
      buildingInput.value = SigningFlow.getSession().recipientBuilding || '';
      updateConfirmEnabled();
      copyAddressHint.textContent = '本人住所を入力しました。異なる場合は編集してください。';
    });
    addressInput.addEventListener('input', () => { copyAddressHint.textContent = ''; });
    box.append(copyRecipientAddressBtn, copyAddressHint);

    // 家族自身の氏名・住所・続柄と、本人の意思に基づく代筆/代理人署名の確認を分けて記録する。
    const familySection = document.createElement('div');
    const capacityHelp = document.createElement('p');
    capacityHelp.className = 'side-panel-hint';
    familySection.appendChild(capacityHelp);
    const relLabel = document.createElement('label');
    relLabel.className = 'signing-field-label';
    const relLabelText = document.createElement('span');
    relLabel.appendChild(relLabelText);
    const relInput = document.createElement('input');
    relInput.type = 'text';
    relInput.placeholder = '例：長女、配偶者、成年後見人（長女）';
    relInput.value = signingUiState.draft.relationship || '';
    relLabel.appendChild(relInput);
    familySection.appendChild(relLabel);
    const relationshipHint = document.createElement('p'); relationshipHint.className = 'side-panel-hint';
    relationshipHint.textContent = '記入する方とご本人との関係・立場です。同じ方が次の欄にも署名する場合に引き継ぎます。PDFには、この署名欄に対応する続柄欄がある場合だけ印字します。';
    familySection.appendChild(relationshipHint);

    const declRow = document.createElement('label');
    declRow.className = 'signing-checkbox-row';
    const declCheckbox = document.createElement('input');
    declCheckbox.type = 'checkbox';
    declCheckbox.checked = !!signingUiState.draft.declarationChecked;
    declRow.appendChild(declCheckbox);
    declRow.appendChild(document.createTextNode('私は契約者の代理人として、本書面に署名する権限を有していることを認めます。'));
    familySection.appendChild(declRow);
    const authorityLabel = document.createElement('label'); authorityLabel.className = 'signing-field-label authority-required';
    const authorityTitle = document.createElement('span'); authorityTitle.textContent = '代理人として署名できる根拠（必須）';
    authorityLabel.append(authorityTitle);
    const authorityBasisInput = document.createElement('textarea'); authorityBasisInput.rows = 3;
    authorityBasisInput.placeholder = '例：成年後見人／登記事項証明書を確認、本人からの委任／委任状を確認';
    authorityBasisInput.value = signingUiState.draft.authorityBasis || '';
    authorityBasisInput.setAttribute('aria-label','代理権の根拠');
    authorityLabel.append(authorityBasisInput);
    const authorityHint = document.createElement('p'); authorityHint.className = 'side-panel-hint';
    authorityHint.textContent = '「誰として」「何を確認して」代理署名するかを記録します。上の関係・立場とは別に、確認した権限の根拠を書いてください。';
    authorityLabel.append(authorityHint); familySection.append(authorityLabel);
    const scribeRow = document.createElement('label'); scribeRow.className = 'signing-checkbox-row';
    const scribeCheckbox = document.createElement('input'); scribeCheckbox.type = 'checkbox';
    scribeCheckbox.checked = !!signingUiState.draft.recipientConsentConfirmed;
    scribeRow.appendChild(scribeCheckbox);
    scribeRow.appendChild(document.createTextNode('本人が契約内容を確認して同意し、本人の依頼により本人名を代筆することを事業者の担当者として確認しました。'));
    familySection.appendChild(scribeRow);
    box.appendChild(familySection);

    // 事業所がテンプレートに配置した確認チェック欄(例：重要事項説明を聞きました)を、
    // 役割に応じて動的に列挙する。全てチェックしないと署名を確定できないようにする
    const declarationsSection = document.createElement('div'); declarationsSection.className = 'declarations-section';
    box.appendChild(declarationsSection);
    let declarationCheckboxes = []; // [{ field, checkbox }]

    function rebuildDynamicSections() {
      const role = currentRole();
      nameLabelText.textContent=role==='family'?'実際に記入するご家族のお名前':role==='additional'?'署名する方のお名前':'お名前';
      nameInput.placeholder=role==='family'?'例：代筆・代理署名するご家族のお名前':role==='additional'?'例：山田 花子':'例：山田 太郎';
      nameHint.textContent=role==='family'&&selectedCapacity==='scribe'?'入力欄：実際に代筆するご家族の氏名 ／ 手書き欄：利用者本人「'+recipientName+'」の氏名':'';
      nameHint.style.display=nameHint.textContent?'':'none';
      title.textContent = role === 'family' && selectedCapacity === 'scribe' ? 'ご本人のお名前を代筆してください' : role === 'family' ? '代理人ご自身のお名前を署名してください' : role === 'recipient' ? 'ご本人のお名前を署名してください' : 'ご自身のお名前を署名してください';
      const addressFields = findTemplateFieldsForRole(role, ['address'], field.id);
      const relationshipFields = findTemplateFieldsForRole(role, ['relationship'], field.id);
      addressLabel.style.display = addressFields.length ? '' : 'none';
      buildingLabel.style.display = addressFields.length ? '' : 'none';
      copyRecipientAddressBtn.style.display = addressFields.length && role !== 'recipient' && recipientAddress ? '' : 'none';
      if (copyRecipientAddressBtn.style.display === 'none') copyAddressHint.textContent = '';
      addressLabelText.textContent = addressFields.some(item => item.required) ? '記入者住所（PDF印字用・必須）' : '記入者住所（PDF印字用・任意）';
      familySection.style.display = role !== 'recipient' || relationshipFields.length ? '' : 'none';
      relLabel.style.display = role !== 'recipient' || relationshipFields.length ? '' : 'none';
      relationshipHint.style.display = relLabel.style.display;
      relLabelText.textContent = relationshipFields.some(item => item.required) ? 'ご本人との関係・立場（必須）' : 'ご本人との関係・立場（任意）';
      capacityLabel.style.display = role === 'family' && !plannedCapacity ? '' : 'none';
      declRow.style.display = role === 'family' && selectedCapacity === 'representative' ? '' : 'none';
      authorityLabel.style.display = role === 'family' && selectedCapacity === 'representative' ? '' : 'none';
      scribeRow.style.display = role === 'family' && selectedCapacity === 'scribe' ? '' : 'none';
      capacityHelp.textContent = role === 'family' && selectedCapacity === 'scribe'
        ? '手書き欄には、本人の依頼に基づいて利用者本人のお名前を代筆してください。上の氏名欄には、実際に代筆したご家族のお名前を入力します。'
        : role === 'family'
          ? '手書き欄と氏名欄には、代理人ご本人のお名前を記入してください。利用者本人の氏名は署名前の確認で別に記録しています。'
          : '';
      handwritingInstruction.textContent = role === 'family' && selectedCapacity === 'scribe'
        ? '手書き欄：利用者本人のお名前を代筆'
        : role === 'family'
          ? '手書き欄：代理人ご本人のお名前を記入'
          : role === 'additional'
            ? '手書き欄：追加署名者ご本人のお名前を記入'
            : '手書き欄：利用者本人のお名前を記入';

      declarationsSection.innerHTML = '';
      declarationCheckboxes = [];
      const heading = document.createElement('h4'); heading.textContent = 'この書面の確認事項'; declarationsSection.append(heading);
      const declarationGroups = new Map();
      findTemplateFieldsForRole(role, ['declaration_checkbox'], field.id).forEach(f => {
        const label = f.label || '内容を確認しました';
        const required = findTemplateFieldsForRole(role, ['declaration_checkbox'], field.id).some(item => (item.label || '内容を確認しました') === label && item.required);
        if (declarationGroups.has(label)) { declarationCheckboxes.push({field:f,checkbox:declarationGroups.get(label)}); return; }
        const row = document.createElement('label');
        row.className = 'signing-checkbox-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', updateConfirmEnabled);
        row.appendChild(cb);
        row.appendChild(document.createTextNode((required ? '【必須】' : '【任意】') + label));
        declarationGroups.set(label,cb);
        declarationsSection.appendChild(row);
        declarationCheckboxes.push({ field: f, checkbox: cb });
      });
      declarationsSection.hidden = !declarationCheckboxes.length;
      updateConfirmEnabled();
    }

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'tool-button-small signing-expand-toggle';
    expandBtn.textContent = '⤢ 大きく書く';
    const penTools = document.createElement('div'); penTools.className = 'signature-tools';
    const undoBtn = document.createElement('button'); undoBtn.type = 'button'; undoBtn.className = 'tool-button-small'; undoBtn.textContent = '1画戻す'; undoBtn.disabled = true;
    const clearBtn = document.createElement('button'); clearBtn.type = 'button'; clearBtn.className = 'tool-button-small signature-clear'; clearBtn.textContent = '全消去'; clearBtn.disabled = true;
    undoBtn.addEventListener('click', () => modalPadInstance.undo());
    clearBtn.addEventListener('click', () => { if (confirm('この欄の手書き署名をすべて消しますか？')) modalPadInstance.clear(); });
    penTools.append(undoBtn,clearBtn,expandBtn); box.append(penTools);

    const handwritingInstruction = document.createElement('p');
    handwritingInstruction.className = 'side-panel-hint';
    box.appendChild(handwritingInstruction);

    const padWrap = document.createElement('div');
    padWrap.className = 'signature-pad-wrap';
    const canvas = document.createElement('canvas');
    canvas.id = 'signature-canvas';
    canvas.style.height = '220px';
    padWrap.appendChild(canvas);
    box.appendChild(padWrap);
    const penStatus = document.createElement('p');
    penStatus.className = 'side-panel-hint';
    penStatus.setAttribute('role', 'status');
    box.appendChild(penStatus);

    // 開いている間、裏で回り続ける署名欄のパルスアニメーションを止める(style.css参照。
    // 非力な端末でApple Pencilの描画イベント処理と競合するのを避けるため)
    document.body.classList.add('modal-open');
    function closeModal() {
      Object.assign(signingUiState.draft, {typedName:nameInput.value, address:addressInput.value, building:buildingInput.value, relationship:relInput.value, authorityBasis:authorityBasisInput.value});
      backdrop.remove();
      document.body.classList.remove('modal-open');
      modalPadInstance.destroy();
    }

    let isExpanded = false;
    expandBtn.addEventListener('click', () => {
      if (modalPadInstance.canUndo() && !confirm('拡大すると今描いた署名は消えます。よろしいですか？')) return;
      isExpanded = !isExpanded;
      box.classList.toggle('is-expanded', isExpanded);
      expandBtn.textContent = isExpanded ? '⤢ 元のサイズに戻す' : '⤢ 大きく書く';
      canvas.style.height = isExpanded ? '50vh' : '220px';
      // 高さを変えるとcanvasの内容は消えるので、内部状態(有効判定用)もclear()で合わせておく
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      modalPadInstance.clear();
    });

    let fieldFitError='';
    let checkedLayoutKey=null;
    // 署名・代理権限チェック・確認チェック欄が全て揃うまで確定ボタンを押せないようにする
    function updateConfirmEnabled() {
      const role = currentRole();
      undoBtn.disabled = !modalPadInstance.canUndo(); clearBtn.disabled = !modalPadInstance.canUndo();
      const missing = [];
      if (!nameInput.value.trim()) missing.push('実際に記入する方のお名前');
      if (!modalPadInstance.isValid()) missing.push('手書き署名（点だけ・ごく小さい線では確定できません）');
      const linkedFields = findTemplateFieldsForRole(role, ['address','relationship'], field.id);
      if (linkedFields.some(item => item.type === 'address' && item.required) && !addressInput.value.trim()) missing.push('記入者の住所');
      if (linkedFields.some(item => item.type === 'relationship' && item.required) && !relInput.value.trim()) missing.push('本人との関係・立場');
      if (role === 'family' && selectedCapacity === 'scribe' && !scribeCheckbox.checked) missing.push('本人の意思に基づく代筆の確認');
      if (role === 'family' && selectedCapacity === 'representative') {
        if (!declCheckbox.checked) missing.push('代理人として署名する権限の確認');
        if (!authorityBasisInput.value.trim()) missing.push('代理権の根拠（例：成年後見人・委任状など）');
      }
      declarationCheckboxes.filter(d => d.field.required && !d.checkbox.checked).forEach(d => missing.push(d.field.label || '書式の確認事項'));
      // Pencilの移動ごとに呼ばれるため、文字計測は入力・確認項目・日付が変わった時だけ行う。
      const layoutKey=JSON.stringify([role,nameInput.value,addressInput.value,buildingInput.value,relInput.value,declarationCheckboxes.filter(d=>d.checkbox.checked).map(d=>d.field.id),new Date().toDateString()]);
      if (layoutKey !== checkedLayoutKey) {
        checkedLayoutKey=layoutKey; fieldFitError='';
        try {
          const textFields=findTemplateFieldsForRole(role,['name','address','relationship','date','declaration_checkbox'],field.id);
          PdfWriter.assertTextFieldsFit(textFields.map(item=>({field:item,text:item.type==='name'?nameInput.value.trim():item.type==='address'?Models.fullAddress(addressInput.value.trim(),buildingInput.value.trim()):item.type==='relationship'?relInput.value.trim():item.type==='date'?PdfWriter.formatDate(new Date(),item.dateFormat):declarationCheckboxes.some(d=>d.field.id===item.id&&d.checkbox.checked)?item.checkPrintStyle==='check'?'✓':'✓ 確認済み':''})));
        } catch(error) { fieldFitError=error.message; }
      }
      if (fieldFitError) missing.push('印字の収まり：'+fieldFitError);
      missingReasons.textContent = missing.length ? '確定するために必要な項目：' + missing.join(' ／ ') : '入力と確認が揃いました。署名全体を確認して確定してください。';
      missingReasons.classList.toggle('is-ready', !missing.length);
      confirmBtn.disabled = missing.length > 0;
    }

    const missingReasons = document.createElement('p'); missingReasons.id = 'signer-missing-reasons'; missingReasons.className = 'signer-missing-reasons';
    missingReasons.setAttribute('role','status');
    const confirmBtn = bigButton('この内容で確定する', () => {
      const role = currentRole();
      const isFamilyNow = role === 'family';
      if (isFamilyNow && selectedCapacity==='scribe' && nameInput.value.trim()===recipientName.trim() &&
          !confirm('入力したご家族の氏名が利用者本人の氏名と同じです。ここは実際に代筆するご家族のお名前です。\n同姓同名で、ご家族の氏名として正しいことを確認しましたか？')) { nameInput.focus(); return; }
      const typedName = nameInput.value.trim();
      const address = addressLabel.style.display === 'none' ? '' : addressInput.value.trim();
      const building = addressLabel.style.display === 'none' ? '' : buildingInput.value.trim();
      const relationship = relLabel.style.display === 'none' ? '' : relInput.value.trim();
      const signingCapacity = role === 'family' ? selectedCapacity : role === 'additional' ? 'additional' : 'self';
      const declarationChecked = isFamilyNow && signingCapacity === 'representative' ? declCheckbox.checked : false;
      const recipientConsentConfirmed = isFamilyNow && signingCapacity === 'scribe' ? scribeCheckbox.checked : false;
      const authorityBasis = isFamilyNow && signingCapacity === 'representative' ? authorityBasisInput.value.trim() : '';
      if (!typedName) { alert('お名前を入力してください'); return; }
      if (isFamilyNow && signingCapacity === 'scribe' && !recipientConsentConfirmed) { alert('本人の意思確認をしてください'); return; }
      if (isFamilyNow && signingCapacity === 'representative' && (!declarationChecked || !authorityBasis)) { alert('代理権限とその根拠を確認・記録してください'); return; }
      const unchecked = declarationCheckboxes.find(d => d.field.required && !d.checkbox.checked);
      if (unchecked) { alert('「' + (unchecked.field.label || '確認項目') + '」にチェックしてください'); return; }
      try {
        SigningFlow.submitCurrentSigner({
          typedName, address: address || null, building, relationship: relationship || null, declarationChecked,
          signingCapacity, recipientConsentConfirmed, authorityBasis,
          role,
          confirmedDeclarations: [...new Set(declarationCheckboxes.filter(d => d.checkbox.checked).map(d => d.field.label || '確認項目'))],
          confirmedDeclarationIds: declarationCheckboxes.filter(d => d.checkbox.checked).map(d => d.field.id),
          signatureImageDataUrl: modalPadInstance.toDataUrl(),
        });
      } catch (e) {
        alert(e.message);
        return;
      }
      closeModal();
      if (SigningFlow.isQueueComplete()) {
        signingUiState.phase = 'review';
      } else {
        signingUiState.phase = 'handoff';
        signingUiState.draft = {};
      }
      if (signingUiState.docView) signingUiState.docView.pageIndex = null;
      renderSigningStep();
    });
    confirmBtn.disabled = true;
    const cancelBtn = bigButton('書面に戻る', closeModal, true);

    box.append(missingReasons,confirmBtn);
    box.appendChild(cancelBtn);
    backdrop.appendChild(box);
    // 手のひらが外側に触れても署名を破棄しない。閉じる操作はキャンセルボタンに限定。
    document.body.appendChild(backdrop);

    // canvas.width/heightをCSS表示サイズに合わせておかないと、pointer座標とずれる
    // (DOMに追加してからでないとclientWidthが0になるため、appendの後で行う)
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    canvas.addEventListener('pointerdown', event=>{
      if (!fieldFitError) return;
      event.preventDefault(); event.stopImmediatePropagation(); penStatus.textContent='署名前に印字の収まりを確認してください。 '+fieldFitError;
    }, {capture:true});
    const modalPadInstance = SignaturePad.create(canvas, updateConfirmEnabled, () => {
      penStatus.textContent = '端末がペン入力を中断しました。書いた線は残っています。ペンを一度離してから続け、署名全体をご確認ください。';
    });
    box.addEventListener('touchstart', evt => {
      if (modalPadInstance.isDrawingWithPen() && Array.from(evt.changedTouches).some(touch => touch.touchType !== 'stylus')) {
        if (evt.cancelable) evt.preventDefault();
      }
    }, { passive: false });

    // rebuildDynamicSections内のupdateConfirmEnabled()がmodalPadInstanceを参照するため、
    // 必ず上のSignaturePad.create()より後で呼び出す
    declCheckbox.addEventListener('change', updateConfirmEnabled);
    scribeCheckbox.addEventListener('change', updateConfirmEnabled);
    [nameInput,addressInput,buildingInput,relInput,authorityBasisInput].forEach(input => input.addEventListener('input', updateConfirmEnabled));
    rebuildDynamicSections();
  }

  // バックアップ対象のテンプレートをチェックボックスで選ばせるモーダル。
  // 取り込み先の端末で全テンプレートが必要とは限らないため、一括ではなく個別選択できるようにする
  function openBackupSelectionModal() {
    const templates = TemplateStore.list();
    if (templates.length === 0) { alert('バックアップできるテンプレートがありません'); return; }

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'signing-modal-box';

    const title = document.createElement('h3');
    title.textContent = 'バックアップするテンプレートを選択';
    box.appendChild(title);

    const selectAllRow = document.createElement('label');
    selectAllRow.className = 'checkbox-row';
    const selectAllCheckbox = document.createElement('input');
    selectAllCheckbox.type = 'checkbox';
    selectAllRow.appendChild(selectAllCheckbox);
    selectAllRow.appendChild(document.createTextNode('すべて選択'));
    box.appendChild(selectAllRow);

    const list = document.createElement('div');
    list.className = 'backup-select-list';
    const checkboxes = [];
    templates.forEach(t => {
      const row = document.createElement('label');
      row.className = 'checkbox-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = t.id;
      checkboxes.push(cb);
      row.appendChild(cb);
      row.appendChild(document.createTextNode(t.name + (t.versionLabel ? '（' + t.versionLabel + '）' : '') + ' v' + t.version));
      list.appendChild(row);
    });
    box.appendChild(list);

    selectAllCheckbox.addEventListener('change', () => {
      checkboxes.forEach(cb => { cb.checked = selectAllCheckbox.checked; });
    });

    function closeModal() { backdrop.remove(); }

    const confirmBtn = bigButton('バックアップする', () => {
      const selectedIds = checkboxes.filter(cb => cb.checked).map(cb => cb.value);
      if (selectedIds.length === 0) { alert('1つ以上テンプレートを選んでください'); return; }
      ExportModule.exportTemplatesBackup(selectedIds);
      closeModal();
    });
    const cancelBtn = bigButton('キャンセル', closeModal, true);
    box.append(confirmBtn);
    box.appendChild(cancelBtn);

    backdrop.appendChild(box);
    backdrop.addEventListener('click', (evt) => { if (evt.target === backdrop) closeModal(); });
    document.body.appendChild(backdrop);
  }

  // ===== 初回案内 =====
  const WELCOME_SEEN_KEY = 'keiyaku_welcome_seen_v1';
  const HELP_SECTIONS = [
    {title:'最初に知っておくこと', intro:'このアプリは、説明を終えた書面をその場で確認し、同じ端末で順番に署名するためのものです。相手への署名依頼メールや録音の機能はありません。', steps:[
      '事業者が準備：未記入のPDFに署名欄などを配置し、テンプレートとして保存します。',
      '対面で署名：利用者本人の情報と記入する方を確認し、書面を見ながら手書き署名します。',
      '事業者が仕上げ：完成書面を確認し、PDFと監査記録を保存して、相手に控えを渡します。'
    ], note:'iPadではSafariでアプリのURLを開いてください。最初の読み込みには通信が必要です。作業中の情報は自動保存されません。'},
    {title:'1. 事業所と担当者を登録する', steps:[
      'ホームの「事業所・担当者を登録」を押します。',
      '事業所名と、説明・確認を担当する職員の名前を入力します。担当者は1行に1人ずつ入力し、「登録を保存」を押します。',
      '署名後の確認画面では、事業所名が事前入力され、担当者を一覧から選べます。「直接入力する」も選べます。'
    ], note:'登録はこのブラウザに保存されます。別の端末では登録が必要です。利用者の氏名・住所はここに登録しません。'},
    {title:'2. PDFからテンプレートを作る', steps:[
      '「＋ テンプレートを作る」または「新しいテンプレートを作る」を押し、「PDFを選ぶ」で未記入の原本を選びます。',
      '左の「手書き署名」を押してから、PDFの署名する場所をドラッグし、四角い枠を描きます。枠を選ぶと移動・サイズ調整・項目設定ができます。',
      '住所や日付など、書面に必要な項目を同じ方法で配置します。氏名・住所などがどの署名欄に対応するか、設定を確認してください。',
      '文字の枠を選び、文字サイズのバーまたは数値で調整します。住所欄は「住所欄の行数（枠の高さ）」で2・3・4行分を選ぶと、高さが文字サイズに合わせて調整されます。枠の角をドラッグすると自由調整に戻ります。枠内の「印字見本」は架空の例で、契約時には入力内容が入ります。見本は表示を切り替えられます。',
      '署名者の氏名・住所・続柄・日付・確認チェックは、直前に配置または選択した署名欄へ自動で割り当てます。画面上の「次の署名者項目の割当先」で確認できます。別の人の項目を置くときは、その署名欄を押すか「どの署名欄の項目か」を変更してください。利用者本人の氏名・住所は共通情報です。複数ページの書面は「次のページ」で移動し、必要なページにも枠を配置します。書式名と署名方法を設定し、左パネル下部の「テンプレートを保存」を押します。署名欄は設定パネルの「この欄で試し書き」から記入し、「書面で確認」で配置結果を確認できます。テストの筆跡は書式に保存されません。「試し印字を確認」では全体の印字位置も確認してください。'
    ], note:'テンプレートにはPDF全体が保存されます。実際の利用者名や署名が入ったPDFは原本として使わないでください。印字が収まらない場合は、枠を広げる・高さを増やす・文字サイズを調整します。'},
    {title:'3. 署名欄と氏名・住所欄の使い分け', rows:[
      ['手書き署名','ペンや指で名前を書く場所。氏名を自署する枠が署名欄を兼ねる書面では、この項目を使います。'],
      ['利用者氏名（活字）','契約当事者である本人の名前。手書き署名とは別の活字氏名欄がある場合だけ配置します。'],
      ['利用者住所欄','利用者本人の住所。家族が記入しても、本人の住所を印字します。'],
      ['署名者氏名（活字）・署名者住所欄','実際に記入する方の氏名・住所。本人の情報と家族の情報を区別するときに使います。'],
      ['続柄欄・確認チェック欄','その署名欄に対応する続柄や、書面で確認してもらう事項。必要に応じて必須・任意を設定します。']
    ], note:'例：利用者の氏名を自署し、その横に住所を書く書式なら「手書き署名＋利用者住所欄」が基本です。本人用と家族用の欄がある書式は、署名欄を二つ置き、付随する項目の対応先をそれぞれ設定します。'},
    {title:'4. 必要な署名人数を決める', rows:[
      ['本人または家族の1人で完結','先頭の署名欄で、本人または本人に代わって記入する方が署名する書式。'],
      ['必要な場合だけ追加の人も署名','署名前に事業者が追加署名の要否を選びます。代筆時の家族本人の署名を必須にする設定もあります。'],
      ['設定した全員の署名が必要','配置した署名欄すべてを順番に記入する書式。']
    ], note:'「本人名を家族が代筆する場合は、続けて家族本人の署名も必須にする」を使う場合は、署名欄を二つ配置します。以前のテンプレートは設定が維持されるため、編集画面で署名方法を確認してください。'},
    {title:'5. 本人自署・家族の代筆・代理署名', intro:'ホームで書式の「これで署名する」を押します。「署名前の確認（事業者用）」で、利用者本人の氏名と、今回記入する方を確認します。利用者住所欄がある書式では、本人の住所も入力します。', steps:[
      '本人が自署する場合：本人を選び、端末を渡します。書面を確認し、強調された署名欄を押して、本人がご自身の名前を書きます。署名枠の上の「1画戻す」で最後の一筆を取り消し、「全消去」でこの欄の筆跡をすべて消せます。',
      '氏名・住所・日付などの枠への収まりを署名前に確認します。収まらない場合は案内に沿って入力を確認するか、署名前に書式の枠を調整してください。署名画面では入力変更時に再確認し、文字を黙って省略しません。',
      '本人の意思に基づく家族の代筆：家族と代筆を選びます。入力欄には実際に代筆する家族の名前、手書き欄には本人の名前を記入します。本人の意思に基づく記入であることを確認します。',
      '代筆・代理署名では、記入する方の「ご本人との関係・立場」も入力できます。PDFに続柄欄がなくても記録し、同じ方が次の欄にも署名する場合に引き継ぎます。代理権の根拠とは別の情報です。',
      '代理人として署名する場合：家族と代理署名を選びます。入力欄・手書き欄には代理人自身の名前を記入し、代理権の確認と、その根拠を記録します。根拠欄には、確認した委任状や成年後見人としての立場などを具体的に書きます。',
      '住所は「住所」と任意の「建物名・部屋番号」に分けて入力します。PDFでは同じ住所枠にまとめて印字されます。本人と同じ住所の場合は、表示されるコピー操作を使えます。',
      '「この内容で確定する」が押せないときは、その直前の「確定するために必要な項目」を確認します。氏名・署名・必須の住所・確認事項・代理権の根拠など、不足項目が表示されます。',
      '代筆するご家族の入力氏名が利用者本人名と同じ場合は確認を表示します。家族の氏名として誤入力なら戻って直し、同姓同名で正しい場合は確認して進めます。確認をキャンセルしても手書きは保持します。',
      '同じ家族が次の家族欄にも署名するときは「先ほど代筆したご家族が続けて署名」などを選びます。入力済みの氏名・住所を引き継ぎ、家族自身の名前で新しく署名・確認します。'
    ], note:'アプリは本人の契約能力や代理権の有無を判断しません。誰の意思に基づき、誰がどの立場で記入するかを事業者が確認してください。署名を訂正する場合は、その人以降の署名を取り直します。'},
    {title:'6. 完成書面を確認し、ファイルを保存する', steps:[
      '署名が揃ったら、事業所名・説明確認担当者・控えの交付方法を確認します。電子で渡す場合は、受取人の承諾確認も行います。',
      '「完成書面を確認」で、署名・住所・日付などが正しい位置に入り、文字が枠に収まっているか、全ページを確認します。「印字内容を確認しました」を押します。',
      '「確定してPDFを作成」を押します。「署名書類ができました」で、署名済みPDFと監査記録を一つずつ保存します。',
      '対応端末では「共有」から端末の共有先を選べます。表示されないファイルは「保存」を使ってください。共有しても保存や相手の受領が完了したとは判定しないため、共有先で確認します。',
      'iPadでは保存操作に応じてダウンロードや共有画面が開きます。Safariのダウンロード一覧や「ファイル」アプリで保存先を確認し、PDFを開いて内容を確認してください。',
      '監査記録（JSON）はPDFと一緒に保管します。JSONを直接読めなくても、ホームの「保存した書類を照合」から確認できます。保存先を確認したら、画面の保存確認にチェックします。'
    ], note:'保存・共有ボタンを押しただけでは、保存完了や相手の受領をアプリは確認できません。完成データは再読み込みで失われます。閉じる前に保存してください。契約の有効性や記録の真正性をアプリが保証するものではありません。'},
    {title:'7. 控えを渡し、交付記録を残す', steps:[
      '署名済みPDFを印刷する、または合意した方法で電子ファイルを渡すなど、事業所の運用に沿って控えを交付します。このアプリから自動送信はしません。',
      '完了画面で「控えを渡した相手」と交付の詳細を入力し、交付結果を選びます。まだ渡していない場合は、その状態を選びます。',
      '「交付記録を保存」でJSONを保存し、PDF・監査記録と一緒に保管します。',
      '記録を読むときは、ホームの「保存した書類を照合」で交付記録を選び、「交付記録を読む」を押します。PDFも選べば、記録との対応をハッシュで照合できます。'
    ], note:'交付記録は事業者が入力した記録です。実際の受領を認証するものではありません。PDFと監査記録のハッシュ一致も、本人性や契約の有効性を確認するものではありません。'},
    {title:'8. 中断・再開とテンプレートのバックアップ', steps:[
      'ホームへ戻っただけなら「入力中の契約に戻る」で続けられます。再読み込みや端末の終了には備えられないため、区切りのよい時点で途中保存してください。',
      '「途中保存（暗号化）」で12文字以上のパスワードを二回入力し、「暗号化して保存」を押します。続けて「途中保存ファイルを端末へ保存」を押し、「契約途中保存_日時.json」が実際に保存されたことを確認します。中身は暗号化されており、パスワードなしでは復元できません。',
      '再開はホームの「途中保存ファイルから再開」。「契約途中保存」で始まるJSONファイルとパスワードを指定します。以前の.keiyakuファイルも読み込めます。ファイルアプリで直接開かず、このアプリで選択してください。最後に手動保存した時点から戻ります。未確定の手書き筆跡は保存されません。',
      'PDFのページ数に固定制限はありません。1書式20MBまでで、保存できる総量は端末・ブラウザによって変わります。選択後にページ数・容量を表示します。保存に失敗したときは「編集中の書式をバックアップ」で退避でき、ホームの「バックアップから復元・追加」で編集を再開できます。ブラウザのデータを消すと書式も消えるため、別途バックアップを保管してください。',
      '別の端末でも書式を使う場合は「テンプレートをバックアップ」で必要な書式を保存し、その端末で「バックアップから復元・追加」を押します。これは署名途中の契約ではなく、未記入の書式のバックアップです。'
    ], note:'途中保存は自動ではありません。パスワードを忘れると復元できず、最後の保存以降の作業も復元できません。契約のPDF・記録・途中保存ファイルは、事業所の保管方法に沿って管理してください。'}
  ];

  function showWelcomeOverlay() {
    const previousFocus = document.activeElement;
    const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop';
    const box = document.createElement('div'); box.className = 'signing-modal-box welcome-modal-box';
    box.setAttribute('role','dialog'); box.setAttribute('aria-modal','true'); box.setAttribute('aria-labelledby','help-title');
    const title = document.createElement('h3'); title.id = 'help-title'; title.textContent = '使い方ガイド';
    const lead = document.createElement('p'); lead.className = 'welcome-lead';
    lead.textContent = '初めての準備から、署名・保存・控えの交付まで。知りたい項目を選ぶと、その操作を詳しく読めます。';
    const close = () => { backdrop.remove(); if (previousFocus?.isConnected) previousFocus.focus(); };
    const closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.className = 'tool-button-small'; closeBtn.textContent = '閉じる'; closeBtn.addEventListener('click',close);
    const header = document.createElement('div'); header.className = 'help-header'; header.append(title,closeBtn);
    box.append(header,lead);
    const contents = document.createElement('nav'); contents.className = 'help-contents'; contents.setAttribute('aria-label','使い方の目次');
    const sections = document.createElement('div'); sections.className = 'help-sections';
    HELP_SECTIONS.forEach((section,index) => {
      const details = document.createElement('details'); details.open = index === 0;
      const summary = document.createElement('summary'); summary.textContent = section.title; details.append(summary);
      const link = document.createElement('button'); link.type = 'button'; link.textContent = section.title;
      link.addEventListener('click',() => { details.open = true; details.scrollIntoView({block:'start'}); summary.focus(); }); contents.append(link);
      if (section.intro) { const p = document.createElement('p'); p.textContent = section.intro; details.append(p); }
      if (section.steps) { const list = document.createElement('ol'); section.steps.forEach(text => { const item = document.createElement('li'); item.textContent = text; list.append(item); }); details.append(list); }
      if (section.rows) {
        const table = document.createElement('table'); const caption = document.createElement('caption'); caption.textContent = section.title; caption.className = 'visually-hidden'; table.append(caption);
        section.rows.forEach(([name,text]) => { const row = document.createElement('tr'); const label = document.createElement('th'); label.scope = 'row'; label.textContent = name; const cell = document.createElement('td'); cell.textContent = text; row.append(label,cell); table.append(row); }); details.append(table);
      }
      const note = document.createElement('p'); note.className = 'help-note'; note.textContent = section.note; details.append(note); sections.append(details);
    });
    box.append(contents,sections);
    const startBtn = bigButton('はじめる →',() => { localStorage.setItem(WELCOME_SEEN_KEY,'1'); close(); }); box.append(startBtn);
    box.addEventListener('keydown',event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const focusable = [...box.querySelectorAll('button,summary')].filter(node => node.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    backdrop.append(box); document.body.append(backdrop); closeBtn.focus();
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  function buildCard(titleText, bodyHtml) {
    const card = document.createElement('div');
    card.className = 'signing-card';
    const progress = document.createElement('ol'); progress.className = 'contract-progress'; progress.setAttribute('aria-label','契約の進み具合');
    const activeStep = completedExport ? 3 : signingUiState.phase === 'recipient_name' ? 0 : signingUiState.phase === 'review' ? 2 : 1;
    ['準備','署名','確認','保存'].forEach((label,index) => {
      const step = document.createElement('li'); step.textContent = label;
      if (index < activeStep) step.className = 'is-done';
      if (index === activeStep) { step.className = 'is-current'; step.setAttribute('aria-current','step'); }
      progress.append(step);
    }); card.append(progress);
    const h2 = document.createElement('h2');
    h2.textContent = titleText;
    card.appendChild(h2);
    if (bodyHtml) {
      const body = document.createElement('div');
      body.innerHTML = bodyHtml;
      card.appendChild(body);
    }
    return card;
  }

  function bigButton(text, onClick, secondary) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'big-button' + (secondary ? ' big-button-secondary' : '');
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  async function finalizeSigning() {
    if (signingBusy) return;
    signingBusy = true;
    try { await createFinalArtifacts(); }
    catch (e) { alert('書類を作成できませんでした。入力は保持しています。\n' + e.message); }
    finally { signingBusy = false; }
  }

  async function createFinalArtifacts() {
    const review = signingUiState.review;
    const pendingSession = SigningFlow.getSession();
    pendingSession.operator = { providerName: review.providerName.trim(), staffName: review.staffName.trim() };
    pendingSession.deliveryPlan = { method: review.method, electronicConsent: review.method === 'electronic' && review.electronicConsent };
    SigningFlow.completeSession();
    const session = SigningFlow.getSession();
    // このアプリは個人情報を含む署名データを一切自動保存しない設計(プライバシー優先)のため、
    // ここでPDF生成に失敗すると全署名者の入力がやり直しになってしまう。
    // 必ずエラーを画面に伝え、review画面に留まって再試行できるようにする(sessionはまだ生きている)
    let pdfBytes, artifacts;
    try {
      // 音声のハッシュは証跡ページ(PDF内)にも印字するため、PDF生成より前に計算しておく必要がある
      let audioBytes = null;
      if (sessionAudioBlob) {
        audioBytes = await sessionAudioBlob.arrayBuffer();
        session.hasExplanationAudio = true;
        session.explanationAudioHashSha256 = await HashUtils.sha256Hex(audioBytes);
      }
      pdfBytes = await PdfWriter.buildSignedPdf(currentSigningTemplate, session);
      artifacts = await ExportModule.buildSignedArtifacts(currentSigningTemplate, session, pdfBytes, audioBytes, sessionAudioBlob ? sessionAudioBlob.type : null);
    } catch (e) {
      console.error('署名済みPDFの作成に失敗しました', e);
      alert('署名済みPDFの作成に失敗しました。お手数ですが、もう一度「確定してPDFを作成」を押してください。\n（ここまでの署名内容はまだ失われていません）\n\n' + e.message);
      return;
    }
    // 作成と保存は別の状態。完成バイト列は保持し、保存・再保存時には作り直さない。
    const saved = { artifacts, confirmed: false };
    completedExport = saved;
    signingBusy = false;
    signingUiState.phase = 'done';
    q('btn-nav-resume').classList.add('hidden');
    q('btn-nav-draft-save').classList.add('hidden');
    q('btn-nav-last-export').classList.remove('hidden');
    renderCompletedExport();
    try {
      await TemplateStore.markSigned(currentSigningTemplate.id);
    } catch (e) {
      console.error(e);
      alert('署名書類は作成できました。保存画面から保存してください。\n' +
        'ただしテンプレート側の更新記録に失敗しました: ' + e.message);
    }
  }

  // ===== 無効化・再契約画面 =====
  async function handleVoidConfirm() {
    if (!voidPdfFile) { alert('訂正対象のPDFファイルを選択してください'); return; }
    const reason = el.voidReasonInput.value.trim();
    const staffName = el.voidStaffNameInput.value.trim();
    if (!reason) { alert('訂正・再署名の理由を入力してください'); return; }
    if (!staffName) { alert('手続き実施者名を入力してください'); return; }
    const verificationIdGuess = el.voidVerificationIdInput.value.trim() || null;

    const button = q('btn-void-confirm');
    button.disabled = true;
    let voidRecord;
    try {
      const { hash } = await VoidFlow.computeFileHash(voidPdfFile);
      voidRecord = VoidFlow.buildVoidRecord(hash, reason, staffName, verificationIdGuess);
      const noticeBytes = await VoidFlow.buildVoidNoticePdf(voidRecord);
      const holder = q('void-downloads'); holder.replaceChildren();
      const base = '訂正記録_' + Date.now();
      const status = document.createElement('p'); status.setAttribute('role','status');
      [[noticeBytes,base+'.pdf','application/pdf','訂正記録PDFを保存'],
        [new TextEncoder().encode(JSON.stringify(voidRecord,null,2)),base+'.json','application/json','訂正記録JSONを保存']].forEach(([bytes,name,type,label]) => {
        holder.append(bigButton(label, () => {
          try { ExportModule.downloadBlob(bytes,name,type); status.textContent = '保存操作を開始しました。保存先で確認してください。'; }
          catch(e) { status.textContent = '保存できませんでした。再試行してください。' + e.message; }
        }));
      });
      holder.append(status);
    } catch(e) { alert('訂正記録を作成できませんでした。入力は保持しています。\n' + e.message); return; }
    finally { button.disabled = false; }

    lastVoidRecord = voidRecord;
    el.voidResult.classList.remove('hidden');
    Forms.renderTemplateList(el.voidResignTemplateList, TemplateStore.list(), {
      onUse: (id) => beginSigningWithTemplate(id, {
        previousPdfHash: lastVoidRecord.previousPdfHash,
        previousVerificationId: lastVoidRecord.previousVerificationId,
        voidReason: lastVoidRecord.reason,
      }),
      onEdit: (id) => openTemplateForEditing(id),
      onDelete: () => {},
      onThumbRequest: (t, imgEl) => loadTemplateThumbnail(t).then(dataUrl => {
        if (dataUrl) imgEl.src = dataUrl;
      }),
    });
  }

  // ===== 起動処理 =====
  // このHTMLファイルだけをコピーして別端末で開くと、隣に置くはずの"lib"フォルダを
  // 一緒にコピーし忘れて起きる不具合が実際にあった(PDF関連が読み込めず、画面の一部だけ
  // 中途半端に動く状態になり原因が分かりにくかったため、起動直後にはっきり検知して知らせる)。
  function findMissingLibs() {
    // lib/pdf_worker_src.js・lib/fonts/notosansjp_base64.jsはトップレベルconstで
    // 定義されておりwindowのプロパティにはならないため、window[name]ではなく
    // 各識別子をそのままtypeofで確認する(typeofは未宣言の識別子でも例外を投げない)。
    const missing = [];
    if (typeof pdfjsLib === 'undefined') missing.push('lib/pdf.min.js');
    if (typeof PDF_WORKER_SOURCE === 'undefined') missing.push('lib/pdf_worker_src.js');
    if (typeof PDFLib === 'undefined') missing.push('lib/pdf-lib.min.js');
    if (typeof fontkit === 'undefined') missing.push('lib/fontkit.umd.min.js');
    if (typeof NOTO_SANS_JP_BASE64 === 'undefined') missing.push('lib/fonts/notosansjp_base64.js');
    return missing;
  }

  function showLibMissingError(missingFiles) {
    document.body.innerHTML = '';
    const banner = document.createElement('div');
    banner.className = 'lib-missing-banner';
    banner.innerHTML =
      '<h2> 必要なファイルが読み込めていません</h2>' +
      '<p>このHTMLファイルと同じ場所に「lib」フォルダが一緒に置かれていないと動作しません。</p>' +
      '<p>このHTMLファイルと「lib」フォルダを両方まとめて同じフォルダにコピーしてから、開き直してください。</p>' +
      '<p class="lib-missing-detail">読み込めなかったファイル: ' + missingFiles.join('、') + '</p>';
    document.body.appendChild(banner);
  }

  async function init() {
    const missingLibs = findMissingLibs();
    if (missingLibs.length > 0) {
      showLibMissingError(missingLibs);
      return;
    }
    try { await TemplateStore.init(); } catch(error) {
      const warning = document.createElement('p'); warning.className = 'storage-startup-error'; warning.setAttribute('role','alert');
      warning.textContent = '書式の保存領域を開けませんでした。既存データは削除していません。通常のブラウザで再読み込みしてください。 ' + error.message; document.body.prepend(warning); return;
    }
    Theme.init();
    el.templateList = q('template-list');
    el.saveToast = q('save-toast');
    el.pdfFileInput = q('pdf-file-input');
    el.fieldPalette = q('field-palette');
    el.fieldEditPanel = q('field-edit-panel');
    el.templateNameInput = q('template-name-input');
    el.templateVersionLabelInput = q('template-version-label-input');
    el.pageIndicator = q('page-indicator');
    el.signingStage = q('signing-stage');
    el.voidReasonInput = q('void-reason-input');
    el.voidStaffNameInput = q('void-staff-name-input');
    el.voidVerificationIdInput = q('void-verification-id-input');
    el.voidResult = q('void-result');
    el.voidResignTemplateList = q('void-resign-template-list');
    el.thumbSizeControl = q('thumb-size-control');

    q('toggle-print-preview').addEventListener('change', event => FieldEditor.setPrintPreviewVisible(event.target.checked));
    q('btn-operator-settings').addEventListener('click', () => {
      const settings = OperatorSettings.load(); q('settings-provider').value = settings.providerName; q('settings-staff').value = settings.staffNames.join('\n'); showScreen('settings');
    });
    q('btn-settings-save').addEventListener('click', () => {
      try { OperatorSettings.save({providerName:q('settings-provider').value,staffNames:q('settings-staff').value.split(/\r?\n/)}); showToast('事業所・担当者を登録しました'); showScreen('home'); } catch(e) { alert(e.message); }
    });
    q('btn-settings-home').addEventListener('click', () => showScreen('home'));
    q('btn-nav-draft-save').addEventListener('click', () => openDraftDialog(false));
    q('btn-home-resume').addEventListener('click', () => { if (!hasPendingSigning()) return; showScreen('signing'); renderSigningStep(); });
    q('btn-draft-restore').addEventListener('click', () => openDraftDialog(true));
    q('btn-nav-resume').addEventListener('click', () => { showScreen('signing'); renderSigningStep(); });
    q('btn-nav-home').addEventListener('click', () => { showScreen('home'); renderHomeTemplateList(); });
    q('btn-home-new-template').addEventListener('click', () => { if (signingBusy) return; resetTemplateEditor(); showScreen('template-editor'); });
    q('btn-nav-new-template').addEventListener('click', () => { if (signingBusy) return; resetTemplateEditor(); showScreen('template-editor'); });
    q('btn-nav-void').addEventListener('click', () => { showScreen('void'); });
    q('btn-nav-help').addEventListener('click', showWelcomeOverlay);
    VerificationView.init();
    q('btn-open-verification').addEventListener('click', () => showScreen('verification'));
    q('btn-verification-home').addEventListener('click', () => { showScreen('home'); renderHomeTemplateList(); });
    q('btn-nav-last-export').addEventListener('click', () => {
      if (!completedExport) return;
      showScreen('signing');
      renderCompletedExport();
    });

    el.thumbSizeControl.querySelectorAll('.thumb-size-btn').forEach(btn => {
      btn.addEventListener('click', () => applyThumbSize(btn.dataset.size));
    });
    applyThumbSize(localStorage.getItem(THUMB_SIZE_STORAGE_KEY) || 'medium');

    function openFieldEditPanel(field) {
      FieldEditor.setActiveSignatureForField(field);
      updateEditorFieldSummary();
      Forms.renderFieldEditPanel(el.fieldEditPanel, field, {
        signatureFields: FieldEditor.getSignatureFields(),
        signingMode: q('template-signing-mode').value,
        onChange: () => { FieldEditor.fitAddressRows(field); FieldEditor.renderFieldBoxes(); },
        onOrderChange: (item, position) => { FieldEditor.setSignatureOrder(item, position); },
        onSignatureTest: openSignatureTest,
        // 「どの署名欄の項目か」の選択直後は、枠だけでなく警告文の表示も
        // 最新化したいのでパネルごと作り直す(selectは再描画してもフォーカスを失わない)
        onLinkChange: () => { FieldEditor.renderFieldBoxes(); openFieldEditPanel(field); },
        onDelete: () => { FieldEditor.removeField(field.id); Forms.renderFieldEditPanel(el.fieldEditPanel, null); },
      });
    }

    FieldEditor.init({
      canvasEl: q('pdf-canvas'),
      overlayEl: q('field-overlay'),
      zoomLabelEl: q('zoom-level'),
      onFieldSelected: openFieldEditPanel,
      onPagesChanged: updateEditorFieldSummary,
    });
    FieldEditor.attachDrawHandlers();
    Forms.renderFieldPalette(el.fieldPalette, (type) => FieldEditor.setArmedFieldType(type));

    el.pdfFileInput.addEventListener('change', async () => {
      const file = el.pdfFileInput.files[0];
      if (!file) return;
      if (!confirm('テンプレートには未記入のPDF原本を使ってください。\nPDF全体がこの端末とバックアップに保存されます。実際の利用者の氏名・住所・署名が入っていないことを確認しましたか？')) { el.pdfFileInput.value = ''; return; }
      if (file.size > TemplateStore.MAX_PDF_BYTES) { q('pdf-file-status').textContent = '選択したPDFは20MBを超えています。PDFを軽量化してから選択してください。'; el.pdfFileInput.value=''; return; }
      showToast('PDFを読み込み中...', 15000);
      try {
        const storage = await TemplateStore.getStorageInfo();
        if (storage.estimate && Number.isFinite(storage.estimate.quota) && Number.isFinite(storage.estimate.usage) && file.size*1.5+1024*1024 > storage.estimate.quota-storage.estimate.usage) throw new Error('このPDFを保存するための容量が不足しています。不要な書式をバックアップして削除するか、PDFを軽量化してください。');
        const buffer = await file.arrayBuffer();
        currentPdfBase64 = PdfUtils.arrayBufferToBase64(buffer);
        await withTimeout(FieldEditor.loadPdfBytes(buffer), 20000, 'PDFの読み込みがタイムアウトしました');
        updatePageIndicator();
        showToast('読み込みました', 1200);
      } catch (e) {
        console.error('PDFの読み込みに失敗しました', e);
        alert(PDF_LOAD_ERROR_MESSAGE + '\n\n' + e.message);
        el.pdfFileInput.value = '';
        currentPdfBase64 = null;
        q('pdf-file-status').textContent = e.message;
      }
    });

    q('btn-prev-page').addEventListener('click', () => FieldEditor.goToPage(FieldEditor.getCurrentPageIndex() - 1).then(updatePageIndicator));
    q('btn-next-page').addEventListener('click', () => FieldEditor.goToPage(FieldEditor.getCurrentPageIndex() + 1).then(updatePageIndicator));
    q('btn-zoom-in').addEventListener('click', () => FieldEditor.zoomIn());
    q('btn-zoom-out').addEventListener('click', () => FieldEditor.zoomOut());
    q('btn-fit-view').addEventListener('click', () => FieldEditor.fitToView(q('pdf-stage-wrap')));
    q('btn-save-template').addEventListener('click', saveCurrentTemplate);
    q('btn-backup-editing-template').addEventListener('click', backupEditingTemplate);
    q('btn-preview-template').addEventListener('click', () => previewTemplate());
    q('template-signing-mode').addEventListener('change', () => {
      updateScribeAdditionalSetting();
      Forms.renderFieldEditPanel(el.fieldEditPanel, null);
    });
    updateScribeAdditionalSetting();

    q('btn-export-templates').addEventListener('click', openBackupSelectionModal);
    q('btn-import-templates').addEventListener('click', () => { if (confirm('書式を追加します。同じIDがあっても既存の書式は上書きしません。\nバックアップに個人情報が含まれる場合、この端末にも保存されます。取り込みますか？')) q('import-templates-input').click(); });
    q('import-templates-input').addEventListener('change', async () => {
      const file = q('import-templates-input').files[0];
      if (!file) return;
      try {
        if (file.size > 64*1024*1024) throw new Error('バックアップファイルは64MB以下にしてください。');
        const data=JSON.parse(await file.text());
        if(data && data.format==='keiyaku-template-draft') { await restoreEditingTemplate(data); q('import-templates-input').value=''; return; }
      } catch(error) { q('import-templates-input').value=''; alert('読み込みに失敗しました: '+error.message); return; }
      ExportModule.importTemplatesBackup(file, (err, count) => {
        q('import-templates-input').value = '';
        if (err) { alert('読み込みに失敗しました: ' + err.message); return; }
        showToast(count + '件を取り込みました。同じIDの書式は上書きせず別の書式として保存しています。', 5000);
        renderHomeTemplateList();
      });
    });

    q('void-pdf-input').addEventListener('change', () => { voidPdfFile = q('void-pdf-input').files[0]; });
    q('btn-void-confirm').addEventListener('click', handleVoidConfirm);

    renderHomeTemplateList();
    showScreen('home');
    document.body.dataset.appReady = 'true';

    if (!localStorage.getItem(WELCOME_SEEN_KEY)) showWelcomeOverlay();

    // 署名データはメモリ内のみで保持し自動保存しない設計のため、対面署名の途中で
    // うっかりタブを閉じる・リロードする・戻るボタンを押すと、それまでの署名が全て消えて
    // やり直しになる。誤操作による喪失だけは確認ダイアログで防ぐ(データ自体は保存しない)
    window.addEventListener('beforeunload', (evt) => {
      const midSigning = hasPendingSigning();
      const unconfirmedFiles = completedExport && !completedExport.confirmed;
      if (!midSigning && !unconfirmedFiles) return;
      evt.preventDefault();
      evt.returnValue = '';
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
