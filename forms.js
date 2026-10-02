// 画面上のパネル類(項目パレット・項目編集パネル・テンプレート一覧)のDOM生成を担当。
// pure DOM操作のみ、テンプレート化エンジンは使わない(house styleに合わせる)。
const Forms = (() => {
  const FIELD_TYPE_OPTIONS = [
    { type: 'signature', label: '手書き署名', hint: 'PDFの署名する場所に配置します。書く人は契約時に選びます。' },
    { type: 'date', label: '日付欄', hint: '署名した日付が自動で印字されます(西暦/和暦を選択可)。' },
    { type: 'recipient_name', label: '利用者氏名（活字）', hint: 'PDFに署名とは別の氏名欄がある時だけ配置。家族が署名しても利用者本人の名前を印字します。' },
    { type: 'recipient_address', label: '利用者住所欄', hint: '契約当事者である利用者本人の住所です。家族が署名・代筆しても変わりません。' },
    { type: 'name', label: '署名者氏名（活字）', hint: 'PDFに署名とは別の氏名欄がある時だけ配置。実際に署名した人の名前を印字します。' },
    { type: 'address', label: '署名者住所欄', hint: '実際に署名・代筆した人の住所が、活字で印字されます。' },
    { type: 'relationship', label: '続柄欄', hint: 'ご家族が記入する場合、入力された本人との関係・立場（例：長女、成年後見人）が印字されます。' },
    { type: 'declaration_checkbox', label: '確認チェック欄', hint: '署名時に確認した内容を示します。' },
  ];

  function renderFieldPalette(container, onArmed) {
    container.innerHTML = '';
    FIELD_TYPE_OPTIONS.forEach(opt => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'palette-button';
      const label = document.createElement('span');
      label.className = 'palette-button-label';
      label.textContent = opt.label;
      const hint = document.createElement('span');
      hint.className = 'palette-button-hint';
      hint.textContent = opt.hint;
      btn.append(label, hint);
      btn.title = opt.hint;
      btn.addEventListener('click', () => {
        container.querySelectorAll('.palette-button').forEach(b => b.classList.remove('is-armed'));
        btn.classList.add('is-armed');
        onArmed(opt.type);
      });
      container.appendChild(btn);
    });
  }

  const ROLE_LABELS = {
    recipient: '利用者本人',
    family: 'ご家族（代筆・代理）',
    additional: '追加の署名者',
  };

  function renderFieldEditPanel(container, field, callbacks) {
    container.innerHTML = '';
    if (!field) {
      container.classList.remove('is-open');
      return;
    }
    container.classList.add('is-open');

    const title = document.createElement('h3');
    title.textContent = '項目の設定';
    container.appendChild(title);
    const typeHint = FIELD_TYPE_OPTIONS.find(opt => opt.type === field.type);
    if (typeHint) {
      const description = document.createElement('p');
      description.className = 'side-panel-hint';
      description.textContent = typeHint.hint;
      container.appendChild(description);
    }

    // 署名欄は役割をテンプレート側で固定しない(署名時にその場で本人/家族を選んでもらう設計のため)。
    // 氏名欄・住所欄などの付随項目は、代わりに「どの署名欄の項目か」を明示的に紐付ける
    // (役割だけでマッチングすると、署名欄が複数ある時に別の署名欄のデータが誤って
    // 印字される事故が実際にあったため)
    const signatureFields = callbacks.signatureFields || [];
    if (field.type === 'signature') {
      const roleNote = document.createElement('p');
      roleNote.className = 'side-panel-hint';
      roleNote.textContent = callbacks.signingMode === 'legacy'
        ? '従来の設定では、署名する場面で本人・家族を選びます。'
        : '署名前に事業者が記入する方を確認します。先頭の署名欄は本人または家族、それ以降は追加の署名者用です。';
      container.appendChild(roleNote);
    } else if (!['recipient_name','recipient_address'].includes(field.type)) {
      const linkLabel = document.createElement('label');
      linkLabel.className = 'field-label';
      linkLabel.textContent = 'どの署名欄の項目か';
      const linkSelect = document.createElement('select');
      const noneOption = document.createElement('option');
      noneOption.value = '';
      noneOption.textContent = signatureFields.length ? '未設定（選んでください）' : '（先に署名欄を配置してください）';
      linkSelect.appendChild(noneOption);
      signatureFields.forEach((sf, idx) => {
        const option = document.createElement('option');
        option.value = sf.id;
        option.textContent = sf.label || (idx + 1) + '人目の署名欄';
        linkSelect.appendChild(option);
      });
      linkSelect.value = field.linkedFieldId || '';
      linkSelect.addEventListener('change', () => {
        field.linkedFieldId = linkSelect.value || null;
        // 選択のたびにパネルの警告文も更新したいため、テキスト入力と違って
        // フォーカスを失う心配がないselectの変更時だけはパネルごと再描画する
        (callbacks.onLinkChange || callbacks.onChange)();
      });
      linkLabel.appendChild(linkSelect);
      container.appendChild(linkLabel);
      if (signatureFields.length >= 2 && !field.linkedFieldId) {
        const warn = document.createElement('p');
        warn.className = 'side-panel-hint field-link-warning';
        warn.textContent = '署名欄が複数あります。このままだと印字先が決まらないため、必ず選んでください。';
        container.appendChild(warn);
      }
    }

    // declaration_checkbox(確認チェック欄)だけは、紐付いた署名欄の中でも
    // 「誰が署名した時に表示するか」をさらに絞れる(例：代理権限確認は家族の時だけ等)
    if (field.type === 'declaration_checkbox') {
      const printLabel = document.createElement('label'); printLabel.className = 'field-label'; printLabel.textContent = 'PDFに印字する内容';
      const printSelect = document.createElement('select');
      [['check','✓ のみ（小さなチェック枠用）'],['confirmed','✓ 確認済み（文字の枠用）']].forEach(([value,text]) => { const option = document.createElement('option'); option.value=value; option.textContent=text; printSelect.appendChild(option); });
      printSelect.value = field.checkPrintStyle || 'confirmed';
      printSelect.addEventListener('change', () => { field.checkPrintStyle = printSelect.value; callbacks.onChange(); });
      printLabel.appendChild(printSelect); container.appendChild(printLabel);
      const explanation = document.createElement('p'); explanation.className = 'side-panel-hint';
      explanation.textContent = '契約時にチェックした場合だけ印字します。「確認する内容」には、確認してもらう文を入力してください。同じ文の項目は契約時に1つのチェックにまとめます。別々の同意には、それぞれ異なる文を設定してください。'; container.appendChild(explanation);
      const roleLabel = document.createElement('label');
      roleLabel.className = 'field-label';
      roleLabel.textContent = '表示条件（誰が署名した時に確認させるか）';
      const roleSelect = document.createElement('select');
      Object.keys(ROLE_LABELS).concat(['either']).forEach(role => {
        const option = document.createElement('option');
        option.value = role;
        option.textContent = role === 'either' ? '立場にかかわらず表示' : ROLE_LABELS[role];
        if (field.assignedRole === role) option.selected = true;
        roleSelect.appendChild(option);
      });
      roleSelect.addEventListener('change', () => {
        field.assignedRole = roleSelect.value;
        callbacks.onChange();
      });
      roleLabel.appendChild(roleSelect);
      container.appendChild(roleLabel);
    }

    // 署名欄にも目的のラベルを付け、署名前の確認で識別できるようにする。
    {
      const labelLabel = document.createElement('label');
      labelLabel.className = 'field-label';
      labelLabel.textContent = field.type === 'declaration_checkbox' ? '確認する内容（契約時に表示）' : '項目の表示ラベル';
      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.value = field.label || '';
      labelInput.placeholder = field.type === 'declaration_checkbox' ? '例：重要事項の説明を受け、内容に同意しました' : field.type === 'signature' ? '例：利用者の契約同意、家族の確認' : '例：利用者の氏名';
      labelInput.addEventListener('input', () => {
        field.label = labelInput.value;
        callbacks.onChange();
      });
      labelLabel.appendChild(labelInput);
      container.appendChild(labelLabel);
    }

    if (field.type === 'date') {
      const formatLabel = document.createElement('label');
      formatLabel.className = 'field-label';
      formatLabel.textContent = '日付の表示形式';
      const formatSelect = document.createElement('select');
      [
        { value: 'gregorian', text: '西暦・数字区切り（例: 2026/8/1）' },
        { value: 'gregorian_kanji', text: '西暦・漢字区切り（例: 2026年8月1日）' },
        { value: 'reiwa', text: '和暦（例: 令和8年8月1日）' },
      ].forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.text;
        if ((field.dateFormat || 'gregorian') === opt.value) option.selected = true;
        formatSelect.appendChild(option);
      });
      formatSelect.addEventListener('change', () => {
        field.dateFormat = formatSelect.value;
        callbacks.onChange();
      });
      formatLabel.appendChild(formatSelect);
      container.appendChild(formatLabel);
    }

    // 署名欄以外(画像ではなく活字を印字する項目)は文字サイズを選べる。
    // 枠の幅に収まらない場合は今まで通り自動縮小されるので、ここでは「基準サイズ」の指定になる
    if (field.type !== 'signature') {
      const fontSizeLabel = document.createElement('label');
      fontSizeLabel.className = 'field-label';
      fontSizeLabel.textContent = '文字サイズ（pt・枠に合わせて縮小）';
      const fontSizeInput = document.createElement('input');
      fontSizeInput.type = 'number';
      fontSizeInput.min = '6';
      fontSizeInput.max = '36';
      fontSizeInput.value = field.fontSize || 11;
      function setSize(value) {
        const size = Number(value);
        if (!Number.isFinite(size) || size < 6 || size > 36) return;
        field.fontSize = size; fontSizeInput.value = size; slider.value = size; callbacks.onChange();
      }
      fontSizeInput.step = '0.5';
      fontSizeInput.addEventListener('input', () => setSize(fontSizeInput.value));
      fontSizeLabel.appendChild(fontSizeInput);
      container.appendChild(fontSizeLabel);
      const slider = document.createElement('input'); slider.type = 'range';
      slider.min = '6'; slider.max = '36'; slider.step = '0.5'; slider.value = fontSizeInput.value;
      slider.setAttribute('aria-label','文字サイズを調整');
      slider.addEventListener('input', () => setSize(slider.value)); container.append(slider);
      const hint = document.createElement('p');
      hint.className = 'side-panel-hint';
      hint.textContent = ['address','recipient_address'].includes(field.type)
        ? '住所は枠の高さに合わせて折り返します。6ptでも収まらない場合は出力を止めます。試し印字でご確認ください。'
        : 'PDF出力に近い印字見本が枠内に表示されます。日本語フォントや実際の文字量は「試し印字」で最終確認してください。';
      container.appendChild(hint);
    }

    if (['address','recipient_address'].includes(field.type)) {
      const rowsLabel = document.createElement('label'); rowsLabel.className = 'field-label'; rowsLabel.textContent = '住所欄の行数（枠の高さ）';
      const rowsSelect = document.createElement('select');
      [['custom','自由調整（現在の高さを維持）'],['2','2行分：住所＋建物名'],['3','3行分：長い住所・建物名'],['4','4行分：さらに余裕を持たせる']].forEach(([value,text])=>{const option=document.createElement('option');option.value=value;option.textContent=text;rowsSelect.appendChild(option);});
      rowsSelect.value = field.addressRows ? String(field.addressRows) : 'custom';
      rowsSelect.addEventListener('change',()=>{ if(rowsSelect.value==='custom')delete field.addressRows;else field.addressRows=Number(rowsSelect.value);callbacks.onChange(); });
      rowsLabel.appendChild(rowsSelect);container.appendChild(rowsLabel);
      const rowsHint=document.createElement('p');rowsHint.className='side-panel-hint';rowsHint.textContent='行数を選ぶと、文字サイズに合わせて枠の高さを調整します。文字サイズを変えたときも追従します。枠の角をドラッグすると自由調整へ戻ります。';container.appendChild(rowsHint);
    }

    // 署名欄は活字ではなく手書き画像なので、実際に描かれた署名の大きさによっては
    // 枠に収めても(object-fit:contain)なお小さく見えることがある。PDFによって
    // 枠のサイズ感がバラバラなため、テンプレートごとに表示サイズを調整できるようにする
    if (field.type === 'signature') {
      const scaleLabel = document.createElement('label');
      scaleLabel.className = 'field-label';
      scaleLabel.textContent = '署名の表示サイズ（%、枠に収めた後にさらに拡大縮小）';
      const scaleInput = document.createElement('input');
      scaleInput.type = 'number';
      scaleInput.min = '50';
      scaleInput.max = '200';
      scaleInput.value = field.signatureScale || 100;
      const scaleSlider = document.createElement('input'); scaleSlider.type = 'range'; scaleSlider.min = '50'; scaleSlider.max = '200'; scaleSlider.step = '1'; scaleSlider.value = scaleInput.value;
      scaleSlider.setAttribute('aria-label','署名の表示サイズを調整');
      function setSignatureSize(value) {
        const size = Number(value); if (!Number.isFinite(size) || size < 50 || size > 200) return;
        field.signatureScale = size; scaleInput.value = size; scaleSlider.value = size; callbacks.onChange();
      }
      scaleInput.addEventListener('input', () => setSignatureSize(scaleInput.value));
      scaleSlider.addEventListener('input', () => setSignatureSize(scaleSlider.value));
      scaleLabel.appendChild(scaleInput);
      container.append(scaleLabel,scaleSlider);
      const hint = document.createElement('p');
      hint.className = 'side-panel-hint';
      hint.textContent = '100%を超えると枠からはみ出します。隣の文字との重なりを試し印字で確認してください。';
      container.appendChild(hint);
    }

    if (field.type === 'signature') {
      const orderLabel = document.createElement('label');
      orderLabel.className = 'field-label';
      orderLabel.textContent = '署名する順番';
      const orderInput = document.createElement('input');
      orderInput.type = 'number';
      orderInput.min = '1'; orderInput.max = String(signatureFields.length);
      orderInput.value = field.signOrder;
      orderInput.addEventListener('input', () => {
        const position = Number(orderInput.value);
        if (!Number.isInteger(position) || position < 1 || position > signatureFields.length) return;
        callbacks.onOrderChange(field, position);
      });
      orderLabel.appendChild(orderInput);
      container.appendChild(orderLabel);
      const test = document.createElement('button'); test.type = 'button'; test.className = 'tool-button';
      test.textContent = 'この欄で試し書き'; test.addEventListener('click', () => callbacks.onSignatureTest(field));
      container.appendChild(test);
      const testHint = document.createElement('p'); testHint.className = 'side-panel-hint';
      testHint.textContent = '実際に書いた筆跡を、この枠と完成PDFの見本で確認します。筆跡はテンプレートに保存されません。'; container.appendChild(testHint);
    }

    const requiredRow = document.createElement('label');
    requiredRow.className = 'checkbox-row';
    const requiredInput = document.createElement('input');
    requiredInput.type = 'checkbox';
    requiredInput.checked = field.required;
    requiredInput.addEventListener('change', () => {
      field.required = requiredInput.checked;
      callbacks.onChange();
    });
    requiredRow.appendChild(requiredInput);
    requiredRow.appendChild(document.createTextNode('必須項目にする'));
    container.appendChild(requiredRow);
    if (field.type === 'signature' && callbacks.signingMode !== 'legacy') requiredRow.hidden = true;
    if (field.type === 'signature') {
      const requiredHint = document.createElement('p');
      requiredHint.className = 'side-panel-hint';
      requiredHint.textContent = callbacks.signingMode === 'legacy'
        ? 'OFFにすると、その場でこの署名を省略できます。'
        : '署名の要否は「この書式の署名方法」と署名前の確認で決まります。';
      container.appendChild(requiredHint);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'popup-delete-button';
    deleteBtn.textContent = 'この項目を削除';
    deleteBtn.addEventListener('click', () => callbacks.onDelete());
    container.appendChild(deleteBtn);
  }

  // サムネイル主体のカードグリッドで一覧表示する。書式が視覚的に見分けやすいよう、
  // 文字情報より先にPDF1ページ目の縮小画像を主役として置く。
  function renderTemplateList(container, templates, callbacks) {
    container.innerHTML = '';
    if (templates.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'case-list-empty';
      empty.textContent = '保存されたテンプレートはまだありません。';
      container.appendChild(empty);
      return;
    }
    templates.forEach(t => {
      const card = document.createElement('div');
      card.className = 'template-card';

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'template-card-thumb';
      const thumbImg = document.createElement('img');
      thumbImg.alt = '';
      thumbWrap.appendChild(thumbImg);
      card.appendChild(thumbWrap);
      if (callbacks.onThumbRequest) callbacks.onThumbRequest(t, thumbImg);

      const name = document.createElement('div');
      name.className = 'template-card-name';
      name.textContent = t.name + (t.versionLabel ? '（' + t.versionLabel + '）' : '') + ' v' + t.version;
      card.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'template-card-meta';
      meta.textContent = '更新: ' + new Date(t.updatedAt).toLocaleString('ja-JP') + (t.hasSignedSessions ? '・署名実績あり' : '');
      card.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'template-card-actions';

      const useBtn = document.createElement('button');
      useBtn.type = 'button';
      useBtn.className = 'tool-button-small tool-button-primary';
      useBtn.textContent = 'これで署名する';
      useBtn.addEventListener('click', () => callbacks.onUse(t.id));
      actions.appendChild(useBtn);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'tool-button-small';
      editBtn.textContent = '署名欄を編集';
      editBtn.addEventListener('click', () => callbacks.onEdit(t.id));
      actions.appendChild(editBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'tool-button-small tool-button-danger';
      deleteBtn.textContent = '削除';
      deleteBtn.addEventListener('click', () => callbacks.onDelete(t.id));
      actions.appendChild(deleteBtn);

      card.appendChild(actions);
      container.appendChild(card);
    });
  }

  return { renderFieldPalette, renderFieldEditPanel, renderTemplateList, ROLE_LABELS };
})();
