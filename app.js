// 起動処理・画面遷移・各モジュールの配線。DOMContentLoaded時に一度だけ実行する。
(function () {
  let currentEditingTemplateId = null;
  let currentPdfBase64 = null;
  let currentSigningTemplate = null;
  let signingUiState = { phase: 'recipient_name', draft: {} };
  let lastVoidRecord = null;
  let voidPdfFile = null;
  const templateThumbCache = new Map(); // key: id+'_'+updatedAt -> dataURL(セッション中のみのキャッシュ)

  // 重要事項説明の録音状態。署名データと同じくメモリ内のみで保持し自動保存しない。
  // activeRecording: AudioRecorder.start()の戻り値(録音中のみ)。sessionAudioBlob: 録音済みのBlob
  let activeRecording = null;
  let recordingStartedAt = null;
  let recordingTimerHandle = null;
  let sessionAudioBlob = null;

  const el = {};

  function q(id) { return document.getElementById(id); }

  function showScreen(name) {
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
  const THUMB_SIZE_PRESETS = { small: 110, medium: 150, large: 200 };
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
      onDelete: (id) => {
        if (confirm('このテンプレートを削除しますか？（過去に署名した記録には影響しません）')) {
          TemplateStore.remove(id);
          renderHomeTemplateList();
        }
      },
      onThumbRequest: (t, imgEl) => loadTemplateThumbnail(t).then(dataUrl => {
        if (dataUrl) imgEl.src = dataUrl;
      }),
    });
  }

  // クラウド保存(Googleドライブ)の接続状態をホーム画面に反映する。
  // file://等、OAuthが原理的に使えない環境ではセクションごと隠す
  function renderCloudDriveSection() {
    if (!el.cloudDriveSection) return;
    if (!CloudDrive.isAvailable()) {
      el.cloudDriveSection.classList.add('hidden');
      return;
    }
    el.cloudDriveSection.classList.remove('hidden');
    if (CloudDrive.isConnected()) {
      el.cloudDriveStatus.textContent = '✅ 接続済み（署名完了時に自動で保存されます）';
      el.cloudDriveToggleBtn.textContent = '接続を解除';
    } else {
      el.cloudDriveStatus.textContent = '未接続';
      el.cloudDriveToggleBtn.textContent = 'Googleドライブに接続';
    }
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
      await PdfUtils.renderPageToCanvas(pdfDoc, 1, canvas, 0.15);
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
    currentSigningTemplate = template;
    signingUiState = { phase: 'recipient_name', draft: {}, resignOf: resignOf || null };
    // 前回のセッションの録音が残っていたら破棄する(マイクは既に解放済みのはずだが念のため)
    if (activeRecording) activeRecording.cancel();
    activeRecording = null;
    recordingStartedAt = null;
    if (recordingTimerHandle) clearInterval(recordingTimerHandle);
    recordingTimerHandle = null;
    sessionAudioBlob = null;
    showScreen('signing');
    renderSigningStep();
  }

  // ===== テンプレート編集画面 =====
  function updatePageIndicator() {
    el.pageIndicator.textContent = (FieldEditor.getCurrentPageIndex() + 1) + ' / ' + FieldEditor.getPageCount();
  }

  async function openTemplateForEditing(id) {
    const t = TemplateStore.get(id);
    if (!t) return;
    currentEditingTemplateId = t.id;
    currentPdfBase64 = t.pdfBase64;
    el.templateNameInput.value = t.name;
    el.templateVersionLabelInput.value = t.versionLabel || '';
    Forms.renderFieldEditPanel(el.fieldEditPanel, null);
    showScreen('template-editor');
    showToast('PDFを読み込み中...', 15000);
    try {
      await withTimeout(FieldEditor.loadFromTemplate(t), 20000, 'PDFの読み込みがタイムアウトしました');
      updatePageIndicator();
      showToast('読み込みました', 1200);
    } catch (e) {
      console.error('PDFの読み込みに失敗しました', e);
      alert(PDF_LOAD_ERROR_MESSAGE);
    }
  }

  function resetTemplateEditor() {
    currentEditingTemplateId = null;
    currentPdfBase64 = null;
    el.templateNameInput.value = '';
    el.templateVersionLabelInput.value = '';
    el.pdfFileInput.value = '';
    Forms.renderFieldEditPanel(el.fieldEditPanel, null);
  }

  const FIELD_TYPE_LABELS_FOR_WARNING = {
    signature: '署名欄', date: '日付欄', name: '氏名欄',
    relationship: '続柄欄', declaration_checkbox: '確認チェック欄', address: '住所欄',
  };

  // 「本人の署名欄を家族に直したのに、下の住所欄が本人のままだった」という事故が
  // 実際にあった。役割は項目ごとに独立して持っているだけで自動連動しないため、
  // 同じ役割に同じ種類の項目が複数あれば、設定ミスの可能性が高いとみなして保存前に警告する。
  function findRoleDuplicateWarnings(pages) {
    const counts = {};
    pages.forEach(page => {
      page.fields.forEach(f => {
        if (f.type === 'signature') return; // 署名欄は役割を固定しない設計になったため対象外
        if (f.assignedRole === 'either') return; // どちらでも欄は重複しても曖昧にならない
        const key = f.type + '|' + f.assignedRole;
        counts[key] = (counts[key] || 0) + 1;
      });
    });
    return Object.keys(counts).filter(k => counts[k] >= 2).map(key => {
      const [type, role] = key.split('|');
      return '「' + (FIELD_TYPE_LABELS_FOR_WARNING[type] || type) + '」が「' +
        (ROLE_LABELS[role] || role) + '」に' + counts[key] + '個割り当てられています';
    });
  }

  function saveCurrentTemplate() {
    const name = el.templateNameInput.value.trim();
    if (!name) { alert('書式名を入力してください'); return; }
    if (!currentPdfBase64) { alert('PDFを選択してください'); return; }
    const pages = FieldEditor.getPages();
    const versionLabel = el.templateVersionLabelInput.value.trim();

    const roleWarnings = findRoleDuplicateWarnings(pages);
    if (roleWarnings.length) {
      const msg = '保存前にご確認ください（役割の設定ミスの可能性があります）:\n\n・' +
        roleWarnings.join('\n・') + '\n\nこのまま保存しますか？';
      if (!confirm(msg)) return;
    }

    // localStorageの保存容量超過(QuotaExceededError等)はここで必ず捕まえる。
    // 捕まえずに画面遷移まで進んでしまうと、実際には保存されていないのに保存完了したように
    // 見えてしまい、せっかく配置した署名欄の作業がまるごと消えてしまう
    let versionedFrom = null;
    try {
      if (currentEditingTemplateId) {
        const existing = TemplateStore.get(currentEditingTemplateId);
        const updated = Object.assign({}, existing, { name, versionLabel, pdfBase64: currentPdfBase64, pages });
        const saved = TemplateStore.saveEdit(updated);
        currentEditingTemplateId = saved.id;
        versionedFrom = saved.versionedFrom || null;
      } else {
        const created = Models.createTemplate({ name, versionLabel, pdfBase64: currentPdfBase64, pages });
        TemplateStore.saveNew(created);
        currentEditingTemplateId = created.id;
      }
    } catch (e) {
      alert(e.message);
      return; // 画面遷移せず編集画面に留まる(作業中の内容はまだ手元にあるので、バックアップ等の対処後に再度保存できる)
    }
    if (versionedFrom) {
      showToast('署名実績があるため新版(v' + (versionedFrom + 1) + ')として保存しました', 4000);
    } else {
      showToast('テンプレートを保存しました');
    }
    showScreen('home');
    renderHomeTemplateList();
  }

  // ===== 署名フロー画面 =====
  const ROLE_LABELS = { recipient: '利用者本人', family: 'ご家族（代理）', either: '署名者' };

  function renderSigningStep() {
    const stage = el.signingStage;
    stage.innerHTML = '';

    if (signingUiState.phase === 'recipient_name') {
      const card = buildCard('👤 利用者名の確認', '<p>これから署名する契約の対象となる利用者様のお名前を入力してください。保存されるファイル名に使われます。</p>');
      const label = document.createElement('label');
      label.className = 'signing-field-label';
      label.textContent = '利用者名';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = '例：介護 太郎';
      label.appendChild(input);
      card.appendChild(label);
      const nextBtn = bigButton('次へ進む', () => {
        SigningFlow.startSession(currentSigningTemplate, input.value.trim(), signingUiState.resignOf);
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
      const card = buildCard('📱 端末をお渡しください',
        '<p class="signing-progress">署名 ' + progress.current + ' / ' + progress.total + '</p>' +
        '<p>次に署名される方に端末をお渡しし、内容をご確認いただいた上で「続ける」を押してください。</p>');
      const nextBtn = bigButton('続ける', () => {
        signingUiState.phase = 'document';
        signingUiState.draft = { typedName: '', relationship: '', declarationChecked: false };
        if (signingUiState.docView) signingUiState.docView.pageIndex = null;
        renderSigningStep();
      });
      card.appendChild(nextBtn);
      // 必須にしていない署名欄は、今回は不要と判断してその場で終了できる
      // (例：本人の署名だけで契約が完結し、ご家族の署名は不要というケース)。
      // 「続ける」の陰に隠れる二次ボタンにせず、同じくらい選びやすい見た目にしておく
      if (!field.required) {
        const skipBtn = bigButton('✅ ここで契約を終了する（この署名は不要）', () => {
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
        ? '<p><strong>対象者: ' + escapeHtml(session.recipientName) + ' 様</strong></p>' : '';
      const card = buildCard('✅ 内容の確認', recipientLine + '<p>以下の内容で契約を確定します。よろしければ「確定してPDFを作成」を押してください。</p>');
      session.signers.forEach((s, i) => {
        const row = document.createElement('div');
        row.className = 'signer-thumb-row';
        const img = document.createElement('img');
        img.src = s.signatureImageDataUrl;
        row.appendChild(img);
        const info = document.createElement('div');
        info.className = 'signer-thumb-info';
        info.textContent = (ROLE_LABELS[s.role] || s.role) + '　' + s.typedName + (s.relationship ? '（続柄: ' + s.relationship + '）' : '');
        row.appendChild(info);
        // やり直せるのは一番最後に署名した人だけ(SigningFlow.redoLastSigner()の仕様に合わせる)
        if (i === session.signers.length - 1) {
          const redoRowBtn = document.createElement('button');
          redoRowBtn.type = 'button';
          redoRowBtn.className = 'tool-button-small';
          redoRowBtn.textContent = 'この署名をやり直す';
          redoRowBtn.addEventListener('click', () => {
            SigningFlow.redoLastSigner();
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
        warn.textContent = '⚠️ 署名者が1人もいないため、契約を確定できません。ホームに戻ってやり直してください。';
        card.appendChild(warn);
        const homeBtn = bigButton('ホームに戻る', () => { showScreen('home'); renderHomeTemplateList(); }, true);
        card.appendChild(homeBtn);
      } else {
        // 連打で二重にPDFが作られる(重複ダウンロード)のを防ぐため、押した瞬間に無効化する。
        // 失敗した場合だけ再度押せるように戻す(finalizeSigning側でreturnする経路)
        const finalizeBtn = bigButton('🔒 確定してPDFを作成', () => {
          finalizeBtn.disabled = true;
          finalizeSigning().finally(() => { finalizeBtn.disabled = false; });
        });
        card.appendChild(finalizeBtn);
      }
      stage.appendChild(card);
      return;
    }

    if (signingUiState.phase === 'done') {
      const fileNameLine = signingUiState.lastFileNameBase
        ? '<p class="signing-filename">保存ファイル名: ' + escapeHtml(signingUiState.lastFileNameBase) + '.pdf</p>' : '';
      const card = buildCard('🎉 完了しました', '<p>署名済みPDFと監査記録をダウンロードしました。内容をご確認の上、事業所側で保管してください。</p>' + fileNameLine);
      const homeBtn = bigButton('ホームに戻る', () => { showScreen('home'); renderHomeTemplateList(); });
      card.appendChild(homeBtn);
      stage.appendChild(card);
      return;
    }
  }

  function findFieldPageIndex(template, fieldId) {
    return template.pages.findIndex(p => p.fields.some(f => f.id === fieldId));
  }

  function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    return Math.floor(totalSec / 60) + ':' + String(totalSec % 60).padStart(2, '0');
  }

  // 重要事項説明の録音コントロール。任意機能なので、非対応環境では何も出さずに
  // 署名フロー自体は普通に進められるようにする。状態(idle/録音中/録音済み)は
  // モジュール変数(activeRecording/sessionAudioBlob)で持ち、document画面が再描画される
  // 度にこの関数も呼ばれるので、その時々の状態に合わせて作り直す
  function renderAudioRecorderControls() {
    const wrap = document.createElement('div');
    wrap.className = 'audio-recorder-box';
    if (!AudioRecorder.isSupported()) return wrap;

    if (activeRecording) {
      const status = document.createElement('span');
      status.className = 'audio-recorder-status is-recording';
      wrap.appendChild(status);
      const updateElapsed = () => { status.textContent = '🔴 録音中… ' + formatElapsed(Date.now() - recordingStartedAt); };
      updateElapsed();
      if (recordingTimerHandle) clearInterval(recordingTimerHandle);
      recordingTimerHandle = setInterval(updateElapsed, 1000);

      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'tool-button-small';
      stopBtn.textContent = '⏹ 録音を終了';
      stopBtn.addEventListener('click', async () => {
        clearInterval(recordingTimerHandle);
        recordingTimerHandle = null;
        const rec = activeRecording;
        activeRecording = null;
        sessionAudioBlob = await rec.stop();
        renderSigningStep();
      });
      wrap.appendChild(stopBtn);
      return wrap;
    }

    if (sessionAudioBlob) {
      const status = document.createElement('span');
      status.className = 'audio-recorder-status';
      status.textContent = '🎤 説明の録音を保存しました';
      wrap.appendChild(status);
      const redoBtn = document.createElement('button');
      redoBtn.type = 'button';
      redoBtn.className = 'tool-button-small';
      redoBtn.textContent = '録音をやり直す';
      redoBtn.addEventListener('click', () => { sessionAudioBlob = null; renderSigningStep(); });
      wrap.appendChild(redoBtn);
      return wrap;
    }

    const startBtn = document.createElement('button');
    startBtn.type = 'button';
    startBtn.className = 'tool-button-small';
    startBtn.textContent = '🎙️ 重要事項説明の様子を録音する（任意）';
    startBtn.addEventListener('click', async () => {
      try {
        activeRecording = await AudioRecorder.start();
        recordingStartedAt = Date.now();
        renderSigningStep();
      } catch (e) {
        console.error('マイクを使用できませんでした', e);
        alert('マイクを使用できませんでした。録音せずに進めることもできます。\n' + e.message);
      }
    });
    wrap.appendChild(startBtn);
    return wrap;
  }

  // 文書プレビュー画面: 実際のPDFを表示し、今から署名する欄をハイライトする。
  // タップするとその場で署名モーダルが開く(field_editor.jsと同じPdfUtilsの描画を流用)。
  async function renderDocumentPhase(stage) {
    const field = SigningFlow.getCurrentField();
    const progress = SigningFlow.getProgress();

    const card = buildCard('📄 内容のご確認とご署名',
      '<p class="signing-progress">署名 ' + progress.current + ' / ' + progress.total + '</p>' +
      '<p>契約内容をご確認いただき、下の書式内でハイライトされた署名欄をタップしてください。</p>');

    card.appendChild(renderAudioRecorderControls());

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

  // currentSigningTemplateの全ページから、指定した役割・種類に一致するフィールドを集める。
  // 「どちらでも」欄はここでは扱わない(役割が確定した後の呼び出し側でrole文字列として渡す)
  function findTemplateFieldsForRole(role, types) {
    const results = [];
    currentSigningTemplate.pages.forEach(page => {
      page.fields.forEach(f => {
        if (!types.includes(f.type)) return;
        if (f.assignedRole === role || f.assignedRole === 'either') results.push(f);
      });
    });
    return results;
  }

  // 文書上のハイライトされた署名欄をタップした時に開くモーダル。
  // 名前・住所・続柄・代理権限チェック・事業所が配置した確認チェック欄・署名パッドをまとめてここで完結させる。
  function openSignatureModal() {
    const field = SigningFlow.getCurrentField();

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'signing-modal-box';

    const title = document.createElement('h3');
    title.textContent = '✍️ ご署名';
    box.appendChild(title);

    // 署名欄は役割をテンプレート側で固定しない設計のため、まず必ずどちらの立場で
    // 署名するかを選んでもらう。これによって続柄欄・代理権限チェック・確認チェック欄の表示が動的に切り替わる。
    // プルダウンだと選択に手間取るため、タップ一発で選べる二択ボタンにする(タブレット操作前提のため)
    const roleLabel = document.createElement('div');
    roleLabel.className = 'signing-field-label';
    roleLabel.textContent = 'どちらの立場で署名しますか';
    box.appendChild(roleLabel);

    const roleToggle = document.createElement('div');
    roleToggle.className = 'signing-role-toggle';
    let selectedRole = 'recipient'; // 一番多いケース(本人が自分で署名)を初期値にしておく
    const roleToggleButtons = {};
    [['recipient', '利用者本人'], ['family', 'ご家族（代理）']].forEach(([value, text]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'signing-role-toggle-btn';
      btn.textContent = text;
      btn.addEventListener('click', () => {
        selectedRole = value;
        Object.values(roleToggleButtons).forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        rebuildDynamicSections();
      });
      roleToggle.appendChild(btn);
      roleToggleButtons[value] = btn;
    });
    roleToggleButtons.recipient.classList.add('is-active');
    box.appendChild(roleToggle);

    function currentRole() { return selectedRole; }

    const nameLabel = document.createElement('label');
    nameLabel.className = 'signing-field-label';
    nameLabel.textContent = 'お名前';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    // 利用者本人が署名する場合は最初に入力した利用者名をそのまま流用する(二重入力の手間を省く)。
    // ご家族代理の場合は別人の可能性があるため空欄のまま、そのつど入力してもらう。
    const recipientName = SigningFlow.getSession().recipientName || '';
    nameInput.value = signingUiState.draft.typedName
      || (currentRole() === 'recipient' ? recipientName : '');
    nameLabel.appendChild(nameInput);
    box.appendChild(nameLabel);

    const addressLabel = document.createElement('label');
    addressLabel.className = 'signing-field-label';
    addressLabel.textContent = 'ご住所';
    const addressInput = document.createElement('input');
    addressInput.type = 'text';
    addressInput.placeholder = '例：〇〇市〇〇町1-2-3';
    addressInput.value = signingUiState.draft.address || '';
    addressLabel.appendChild(addressInput);
    box.appendChild(addressLabel);

    // ご家族代理の場合だけ出す続柄・代理権限チェック(roleSelectがあれば動的に表示切替)
    const familySection = document.createElement('div');
    const relLabel = document.createElement('label');
    relLabel.className = 'signing-field-label';
    relLabel.textContent = 'ご本人との続柄';
    const relInput = document.createElement('input');
    relInput.type = 'text';
    relInput.placeholder = '例：長男';
    relInput.value = signingUiState.draft.relationship || '';
    relLabel.appendChild(relInput);
    familySection.appendChild(relLabel);

    const declRow = document.createElement('label');
    declRow.className = 'signing-checkbox-row';
    const declCheckbox = document.createElement('input');
    declCheckbox.type = 'checkbox';
    declCheckbox.checked = !!signingUiState.draft.declarationChecked;
    declRow.appendChild(declCheckbox);
    declRow.appendChild(document.createTextNode('私は契約者の代理人として、本書面に署名する権限を有していることを認めます。'));
    familySection.appendChild(declRow);
    box.appendChild(familySection);

    // 事業所がテンプレートに配置した確認チェック欄(例：重要事項説明を聞きました)を、
    // 役割に応じて動的に列挙する。全てチェックしないと署名を確定できないようにする
    const declarationsSection = document.createElement('div');
    box.appendChild(declarationsSection);
    let declarationCheckboxes = []; // [{ field, checkbox }]

    function rebuildDynamicSections() {
      const role = currentRole();
      familySection.style.display = role === 'family' ? '' : 'none';

      declarationsSection.innerHTML = '';
      declarationCheckboxes = [];
      findTemplateFieldsForRole(role, ['declaration_checkbox']).forEach(f => {
        const row = document.createElement('label');
        row.className = 'signing-checkbox-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', updateConfirmEnabled);
        row.appendChild(cb);
        row.appendChild(document.createTextNode(f.label || '内容を確認しました'));
        declarationsSection.appendChild(row);
        declarationCheckboxes.push({ field: f, checkbox: cb });
      });
      updateConfirmEnabled();
    }

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'tool-button-small signing-expand-toggle';
    expandBtn.textContent = '⤢ 大きく書く';
    box.appendChild(expandBtn);

    const padWrap = document.createElement('div');
    padWrap.className = 'signature-pad-wrap';
    const canvas = document.createElement('canvas');
    canvas.id = 'signature-canvas';
    canvas.style.height = '220px';
    padWrap.appendChild(canvas);
    box.appendChild(padWrap);

    function closeModal() { backdrop.remove(); }

    let isExpanded = false;
    expandBtn.addEventListener('click', () => {
      if (modalPadInstance.isValid() && !confirm('拡大すると今描いた署名は消えます。よろしいですか？')) return;
      isExpanded = !isExpanded;
      box.classList.toggle('is-expanded', isExpanded);
      expandBtn.textContent = isExpanded ? '⤢ 元のサイズに戻す' : '⤢ 大きく書く';
      canvas.style.height = isExpanded ? '50vh' : '220px';
      // 高さを変えるとcanvasの内容は消えるので、内部状態(有効判定用)もclear()で合わせておく
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      modalPadInstance.clear();
    });

    // 署名・代理権限チェック・確認チェック欄が全て揃うまで確定ボタンを押せないようにする
    function updateConfirmEnabled() {
      const role = currentRole();
      const sigValid = modalPadInstance.isValid();
      const familyOk = role !== 'family' || declCheckbox.checked;
      const declarationsOk = declarationCheckboxes.every(d => d.checkbox.checked);
      confirmBtn.disabled = !(sigValid && familyOk && declarationsOk);
    }

    const confirmBtn = bigButton('この内容で確定する', () => {
      const role = currentRole();
      const isFamilyNow = role === 'family';
      const typedName = nameInput.value.trim();
      const address = addressInput.value.trim();
      const relationship = isFamilyNow ? relInput.value.trim() : '';
      const declarationChecked = isFamilyNow ? declCheckbox.checked : false;
      if (!typedName) { alert('お名前を入力してください'); return; }
      if (isFamilyNow && !declarationChecked) { alert('代理権限の確認にチェックしてください'); return; }
      const unchecked = declarationCheckboxes.find(d => !d.checkbox.checked);
      if (unchecked) { alert('「' + (unchecked.field.label || '確認項目') + '」にチェックしてください'); return; }
      try {
        SigningFlow.submitCurrentSigner({
          typedName, address: address || null, relationship: relationship || null, declarationChecked,
          role,
          confirmedDeclarations: declarationCheckboxes.map(d => d.field.label || '確認項目'),
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
    const redoBtn = bigButton('やり直す', () => modalPadInstance.clear(), true);
    const cancelBtn = bigButton('キャンセル', closeModal, true);

    box.appendChild(confirmBtn);
    box.appendChild(redoBtn);
    box.appendChild(cancelBtn);
    backdrop.appendChild(box);
    backdrop.addEventListener('click', (evt) => { if (evt.target === backdrop) closeModal(); });
    document.body.appendChild(backdrop);

    // canvas.width/heightをCSS表示サイズに合わせておかないと、pointer座標とずれる
    // (DOMに追加してからでないとclientWidthが0になるため、appendの後で行う)
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    const modalPadInstance = SignaturePad.create(canvas, updateConfirmEnabled);

    // rebuildDynamicSections内のupdateConfirmEnabled()がmodalPadInstanceを参照するため、
    // 必ず上のSignaturePad.create()より後で呼び出す
    declCheckbox.addEventListener('change', updateConfirmEnabled);
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
    title.textContent = '⬇ バックアップするテンプレートを選択';
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
    box.appendChild(confirmBtn);
    box.appendChild(cancelBtn);

    backdrop.appendChild(box);
    backdrop.addEventListener('click', (evt) => { if (evt.target === backdrop) closeModal(); });
    document.body.appendChild(backdrop);
  }

  // ===== 初回案内 =====
  const WELCOME_SEEN_KEY = 'keiyaku_welcome_seen_v1';
  const WELCOME_STEPS = [
    { emoji: '📄', title: 'PDFに署名欄を配置', text: '「新しいテンプレートを作る」からPDFを選び、署名欄・氏名欄などをドラッグで配置します。' },
    { emoji: '💾', title: 'テンプレートとして保存', text: '書式名を付けて保存すれば、次回から同じ書式をすぐ使い回せます。' },
    { emoji: '✍️', title: 'その場で署名', text: '「これで署名する」→タブレットをお渡しすれば、対面でその場署名が完結します。' },
  ];

  function showWelcomeOverlay() {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'signing-modal-box welcome-modal-box';

    const title = document.createElement('h3');
    title.textContent = '🖊️ ようこそ、電子契約アプリへ！';
    box.appendChild(title);

    const lead = document.createElement('p');
    lead.className = 'welcome-lead';
    lead.textContent = '契約書・重要事項説明書のPDFに署名欄を置くだけで、タブレットでのその場署名が完結するアプリです。';
    box.appendChild(lead);

    const stepList = document.createElement('div');
    stepList.className = 'welcome-steps';
    WELCOME_STEPS.forEach((s, i) => {
      const item = document.createElement('div');
      item.className = 'welcome-step';
      const emoji = document.createElement('div');
      emoji.className = 'welcome-step-emoji';
      emoji.textContent = s.emoji;
      item.appendChild(emoji);
      const body = document.createElement('div');
      const stepTitle = document.createElement('div');
      stepTitle.className = 'welcome-step-title';
      stepTitle.textContent = (i + 1) + '. ' + s.title;
      const stepText = document.createElement('div');
      stepText.className = 'welcome-step-text';
      stepText.textContent = s.text;
      body.appendChild(stepTitle);
      body.appendChild(stepText);
      item.appendChild(body);
      stepList.appendChild(item);
    });
    box.appendChild(stepList);

    const startBtn = bigButton('はじめる →', () => {
      localStorage.setItem(WELCOME_SEEN_KEY, '1');
      backdrop.remove();
    });
    box.appendChild(startBtn);

    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  function buildCard(titleText, bodyHtml) {
    const card = document.createElement('div');
    card.className = 'signing-card';
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
    SigningFlow.completeSession();
    const session = SigningFlow.getSession();
    // 録音の停止し忘れのまま確定された場合は、ここで自動的に止めて確保する(録音を無駄にしない)
    if (activeRecording) {
      const rec = activeRecording;
      activeRecording = null;
      if (recordingTimerHandle) { clearInterval(recordingTimerHandle); recordingTimerHandle = null; }
      sessionAudioBlob = await rec.stop();
    }
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
      artifacts = await ExportModule.buildSignedArtifacts(currentSigningTemplate, session, pdfBytes, audioBytes);
      ExportModule.saveArtifacts(artifacts);
    } catch (e) {
      console.error('署名済みPDFの作成に失敗しました', e);
      alert('署名済みPDFの作成に失敗しました。お手数ですが、もう一度「確定してPDFを作成」を押してください。\n（ここまでの署名内容はまだ失われていません）\n\n' + e.message);
      return;
    }
    // 署名済みPDF・監査記録のダウンロードは、これより後のTemplateStore更新が失敗しても
    // 既に完了している(契約自体は成立・保存済み)。markSignedはテンプレート側の
    // 「署名実績あり」フラグ更新にすぎないため、失敗してもここで契約自体を失敗扱いにはしない
    try {
      TemplateStore.markSigned(currentSigningTemplate.id);
    } catch (e) {
      console.error(e);
      alert('署名済みPDFのダウンロードは完了しています。\n' +
        'ただしテンプレート側の更新記録に失敗しました: ' + e.message);
    }
    // クラウド保存は端末へのダウンロードが済んだ後の「追加の保存先」という位置づけ。
    // 失敗しても手元にファイルは残っているので、契約自体は失敗扱いにしない
    if (CloudDrive.isConnected()) {
      try {
        await CloudDrive.uploadFile(artifacts.pdfBytes, artifacts.fileNameBase + '.pdf', 'application/pdf');
        await CloudDrive.uploadFile(new TextEncoder().encode(artifacts.auditJson), artifacts.fileNameBase + '_監査記録.json', 'application/json');
        if (artifacts.audioBytes) {
          await CloudDrive.uploadFile(artifacts.audioBytes, artifacts.fileNameBase + '_説明音声.webm', 'audio/webm');
        }
        showToast('Googleドライブにも保存しました');
      } catch (e) {
        console.error('Googleドライブへの保存に失敗しました', e);
        alert('端末へのダウンロードは完了しています。\n' +
          'ただしGoogleドライブへの保存に失敗しました: ' + e.message);
      }
    }
    signingUiState.lastFileNameBase = artifacts.fileNameBase;
    signingUiState.phase = 'done';
    renderSigningStep();
  }

  // ===== 無効化・再契約画面 =====
  async function handleVoidConfirm() {
    if (!voidPdfFile) { alert('無効化したいPDFファイルを選択してください'); return; }
    const reason = el.voidReasonInput.value.trim();
    const staffName = el.voidStaffNameInput.value.trim();
    if (!reason) { alert('無効化理由を入力してください'); return; }
    if (!staffName) { alert('手続き実施者名を入力してください'); return; }
    const verificationIdGuess = el.voidVerificationIdInput.value.trim() || null;

    const { hash } = await VoidFlow.computeFileHash(voidPdfFile);
    const voidRecord = VoidFlow.buildVoidRecord(hash, reason, staffName, verificationIdGuess);
    const noticeBytes = await VoidFlow.buildVoidNoticePdf(voidRecord);

    ExportModule.downloadBlob(noticeBytes, '無効化通知_' + Date.now() + '.pdf', 'application/pdf');
    ExportModule.downloadBlob(new TextEncoder().encode(JSON.stringify(voidRecord, null, 2)), '無効化記録_' + Date.now() + '.json', 'application/json');

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
      '<h2>⚠️ 必要なファイルが読み込めていません</h2>' +
      '<p>このHTMLファイルと同じ場所に「lib」フォルダが一緒に置かれていないと動作しません。</p>' +
      '<p>このHTMLファイルと「lib」フォルダを両方まとめて同じフォルダにコピーしてから、開き直してください。</p>' +
      '<p class="lib-missing-detail">読み込めなかったファイル: ' + missingFiles.join('、') + '</p>';
    document.body.appendChild(banner);
  }

  function init() {
    const missingLibs = findMissingLibs();
    if (missingLibs.length > 0) {
      showLibMissingError(missingLibs);
      return;
    }
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
    el.cloudDriveSection = q('cloud-drive-section');
    el.cloudDriveStatus = q('cloud-drive-status');
    el.cloudDriveToggleBtn = q('btn-cloud-drive-toggle');

    q('btn-nav-home').addEventListener('click', () => { showScreen('home'); renderHomeTemplateList(); });
    q('btn-nav-new-template').addEventListener('click', () => { resetTemplateEditor(); showScreen('template-editor'); });
    q('btn-nav-void').addEventListener('click', () => { showScreen('void'); });
    q('btn-nav-help').addEventListener('click', showWelcomeOverlay);

    el.thumbSizeControl.querySelectorAll('.thumb-size-btn').forEach(btn => {
      btn.addEventListener('click', () => applyThumbSize(btn.dataset.size));
    });
    applyThumbSize(localStorage.getItem(THUMB_SIZE_STORAGE_KEY) || 'medium');

    FieldEditor.init({
      canvasEl: q('pdf-canvas'),
      overlayEl: q('field-overlay'),
      zoomLabelEl: q('zoom-level'),
      onFieldSelected: (field) => {
        Forms.renderFieldEditPanel(el.fieldEditPanel, field, {
          onChange: () => FieldEditor.renderFieldBoxes(),
          onDelete: () => { FieldEditor.removeField(field.id); Forms.renderFieldEditPanel(el.fieldEditPanel, null); },
        });
      },
      onPagesChanged: () => {},
    });
    FieldEditor.attachDrawHandlers();
    Forms.renderFieldPalette(el.fieldPalette, (type) => FieldEditor.setArmedFieldType(type));

    // PDFが大きすぎると、後で「テンプレートを保存」を押した時にlocalStorage容量超過で
    // 失敗する(base64化すると元のファイルサイズの約1.3倍になる)。項目配置の作業が無駄に
    // ならないよう、選んだ直後の時点で早めに警告する
    const LARGE_PDF_WARN_BYTES = 3 * 1024 * 1024; // 3MB(base64後は約4MB)
    function formatMb(bytes) { return (bytes / (1024 * 1024)).toFixed(1); }

    el.pdfFileInput.addEventListener('change', async () => {
      const file = el.pdfFileInput.files[0];
      if (!file) return;
      if (file.size > LARGE_PDF_WARN_BYTES) {
        const proceed = confirm(
          'このPDFはサイズが大きいです（' + formatMb(file.size) + 'MB）。\n' +
          'ブラウザの保存容量の上限に達し、テンプレートを保存できない可能性があります。\n' +
          'このまま使いますか？（キャンセルすると別のPDFを選び直せます）'
        );
        if (!proceed) { el.pdfFileInput.value = ''; return; }
      }
      showToast('PDFを読み込み中...', 15000);
      try {
        const buffer = await file.arrayBuffer();
        currentPdfBase64 = PdfUtils.arrayBufferToBase64(buffer);
        await withTimeout(FieldEditor.loadPdfBytes(buffer), 20000, 'PDFの読み込みがタイムアウトしました');
        updatePageIndicator();
        showToast('読み込みました', 1200);
      } catch (e) {
        console.error('PDFの読み込みに失敗しました', e);
        alert(PDF_LOAD_ERROR_MESSAGE);
        el.pdfFileInput.value = '';
        currentPdfBase64 = null;
      }
    });

    q('btn-prev-page').addEventListener('click', () => FieldEditor.goToPage(FieldEditor.getCurrentPageIndex() - 1).then(updatePageIndicator));
    q('btn-next-page').addEventListener('click', () => FieldEditor.goToPage(FieldEditor.getCurrentPageIndex() + 1).then(updatePageIndicator));
    q('btn-zoom-in').addEventListener('click', () => FieldEditor.zoomIn());
    q('btn-zoom-out').addEventListener('click', () => FieldEditor.zoomOut());
    q('btn-fit-view').addEventListener('click', () => FieldEditor.fitToView(q('pdf-stage-wrap')));
    q('btn-save-template').addEventListener('click', saveCurrentTemplate);

    q('btn-export-templates').addEventListener('click', openBackupSelectionModal);
    q('btn-import-templates').addEventListener('click', () => q('import-templates-input').click());
    q('import-templates-input').addEventListener('change', () => {
      const file = q('import-templates-input').files[0];
      if (!file) return;
      ExportModule.importTemplatesBackup(file, (err, count) => {
        if (err) { alert('読み込みに失敗しました: ' + err.message); return; }
        showToast(count + '件のテンプレートを復元しました');
        renderHomeTemplateList();
      });
    });

    q('void-pdf-input').addEventListener('change', () => { voidPdfFile = q('void-pdf-input').files[0]; });
    q('btn-void-confirm').addEventListener('click', handleVoidConfirm);

    el.cloudDriveToggleBtn.addEventListener('click', async () => {
      if (CloudDrive.isConnected()) {
        CloudDrive.disconnect();
        renderCloudDriveSection();
        return;
      }
      try {
        el.cloudDriveToggleBtn.disabled = true;
        await CloudDrive.connect();
        showToast('Googleドライブに接続しました');
      } catch (e) {
        console.error('Googleドライブへの接続に失敗しました', e);
        alert('Googleドライブへの接続に失敗しました。\n' + e.message);
      } finally {
        el.cloudDriveToggleBtn.disabled = false;
        renderCloudDriveSection();
      }
    });

    renderHomeTemplateList();
    renderCloudDriveSection();
    showScreen('home');

    if (!localStorage.getItem(WELCOME_SEEN_KEY)) showWelcomeOverlay();

    // 署名データはメモリ内のみで保持し自動保存しない設計のため、対面署名の途中で
    // うっかりタブを閉じる・リロードする・戻るボタンを押すと、それまでの署名が全て消えて
    // やり直しになる。誤操作による喪失だけは確認ダイアログで防ぐ(データ自体は保存しない)
    window.addEventListener('beforeunload', (evt) => {
      const onSigningScreen = q('screen-signing') && q('screen-signing').classList.contains('is-active');
      const midSigning = onSigningScreen && signingUiState &&
        signingUiState.phase !== 'recipient_name' && signingUiState.phase !== 'done';
      if (!midSigning) return;
      evt.preventDefault();
      evt.returnValue = '';
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
