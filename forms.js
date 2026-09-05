// 画面上のパネル類(項目パレット・項目編集パネル・テンプレート一覧)のDOM生成を担当。
// pure DOM操作のみ、テンプレート化エンジンは使わない(house styleに合わせる)。
const Forms = (() => {
  const FIELD_TYPE_OPTIONS = [
    { type: 'signature', label: '✍️ 署名欄', hint: 'タップすると署名パッドが開き、手書きの署名(画像)が入ります。' },
    { type: 'date', label: '📅 日付欄', hint: '署名した日付が自動で印字されます(西暦/和暦を選択可)。' },
    { type: 'name', label: '🈸 氏名欄', hint: '署名した人が入力した名前が、活字(テキスト)で印字されます。手書きの署名欄とセットで置くのがおすすめです。' },
    { type: 'address', label: '🏠 住所欄', hint: '署名した人が入力した住所が、活字で印字されます。' },
    { type: 'relationship', label: '👪 続柄欄', hint: 'ご家族代理の場合、入力された続柄(例：長男)が印字されます。' },
    { type: 'declaration_checkbox', label: '☑️ 確認チェック欄', hint: 'ご家族代理の場合の、代理権限確認チェックの有無を示します。' },
  ];

  function renderFieldPalette(container, onArmed) {
    container.innerHTML = '';
    FIELD_TYPE_OPTIONS.forEach(opt => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'palette-button';
      btn.textContent = opt.label;
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
    family: 'ご家族（代理）',
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

    // 署名欄は役割をテンプレート側で固定しない(署名時にその場で本人/家族を選んでもらう設計のため)。
    // 氏名欄・住所欄などの付随項目は、代わりに「どの署名欄の項目か」を明示的に紐付ける
    // (役割だけでマッチングすると、署名欄が複数ある時に別の署名欄のデータが誤って
    // 印字される事故が実際にあったため)
    const signatureFields = callbacks.signatureFields || [];
    if (field.type === 'signature') {
      const roleNote = document.createElement('p');
      roleNote.className = 'side-panel-hint';
      roleNote.textContent = '署名時に「利用者本人」か「ご家族（代理）」かをその都度選んでいただきます。';
      container.appendChild(roleNote);
    } else {
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
        warn.textContent = '⚠️ 署名欄が複数あります。このままだと印字先が決まらないため、必ず選んでください。';
        container.appendChild(warn);
      }
    }

    // declaration_checkbox(確認チェック欄)だけは、紐付いた署名欄の中でも
    // 「誰が署名した時に表示するか」をさらに絞れる(例：代理権限確認は家族の時だけ等)
    if (field.type === 'declaration_checkbox') {
      const roleLabel = document.createElement('label');
      roleLabel.className = 'field-label';
      roleLabel.textContent = '表示条件（誰が署名した時に確認させるか）';
      const roleSelect = document.createElement('select');
      Object.keys(ROLE_LABELS).concat(['either']).forEach(role => {
        const option = document.createElement('option');
        option.value = role;
        option.textContent = role === 'either' ? 'どちらでも' : ROLE_LABELS[role];
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

    if (field.type === 'name' || field.type === 'relationship' || field.type === 'declaration_checkbox' || field.type === 'address') {
      const labelLabel = document.createElement('label');
      labelLabel.className = 'field-label';
      labelLabel.textContent = '項目の表示ラベル';
      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.value = field.label || '';
      labelInput.placeholder = '例：ご本人との続柄';
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
      fontSizeLabel.textContent = '文字サイズ（pt）';
      const fontSizeInput = document.createElement('input');
      fontSizeInput.type = 'number';
      fontSizeInput.min = '6';
      fontSizeInput.max = '36';
      fontSizeInput.value = field.fontSize || 11;
      fontSizeInput.addEventListener('input', () => {
        field.fontSize = parseInt(fontSizeInput.value, 10) || 11;
        callbacks.onChange();
      });
      fontSizeLabel.appendChild(fontSizeInput);
      container.appendChild(fontSizeLabel);
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
      scaleInput.addEventListener('input', () => {
        field.signatureScale = parseInt(scaleInput.value, 10) || 100;
        callbacks.onChange();
      });
      scaleLabel.appendChild(scaleInput);
      container.appendChild(scaleLabel);
    }

    if (field.type === 'signature') {
      const orderLabel = document.createElement('label');
      orderLabel.className = 'field-label';
      orderLabel.textContent = '署名する順番';
      const orderInput = document.createElement('input');
      orderInput.type = 'number';
      orderInput.min = '1';
      orderInput.value = field.signOrder;
      orderInput.addEventListener('input', () => {
        field.signOrder = parseInt(orderInput.value, 10) || 1;
        callbacks.onChange();
      });
      orderLabel.appendChild(orderInput);
      container.appendChild(orderLabel);
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
    if (field.type === 'signature') {
      const requiredHint = document.createElement('p');
      requiredHint.className = 'side-panel-hint';
      requiredHint.textContent = 'OFFにすると、署名時に「この署名は不要」としてその場でスキップできるようになります（例：本人が署名できたのでご家族の署名は不要、という場合）。';
      container.appendChild(requiredHint);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'popup-delete-button';
    deleteBtn.textContent = '🗑 この項目を削除';
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
      useBtn.className = 'tool-button-small';
      useBtn.textContent = '📝 これで署名する';
      useBtn.addEventListener('click', () => callbacks.onUse(t.id));
      actions.appendChild(useBtn);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'tool-button-small';
      editBtn.textContent = '✏️ 署名欄を編集';
      editBtn.addEventListener('click', () => callbacks.onEdit(t.id));
      actions.appendChild(editBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'tool-button-small tool-button-danger';
      deleteBtn.textContent = '🗑 削除';
      deleteBtn.addEventListener('click', () => callbacks.onDelete(t.id));
      actions.appendChild(deleteBtn);

      card.appendChild(actions);
      container.appendChild(card);
    });
  }

  return { renderFieldPalette, renderFieldEditPanel, renderTemplateList, ROLE_LABELS };
})();
