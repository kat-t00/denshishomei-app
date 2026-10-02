const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setup() {
  const context = vm.createContext({ crypto: require('node:crypto').webcrypto });
  for (const file of ['models.js', 'signing_flow.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return vm.runInContext(`({Models,SigningFlow,template:Models.createTemplate({signingMode:'single',pages:[{widthPt:595,heightPt:842,fields:[Models.createField({id:'sig',type:'signature',x:50,y:50,width:160,height:40})]}]})})`, context);
}

const signature = 'data:image/png;base64,signature';

test('本人の氏名・住所を保ち、本人の意思による家族代筆を代理署名と区別する', () => {
  const { SigningFlow: flow, template } = setup();
  flow.startSession(template, '本人 太郎', null, { recipientAddress: '本人住所', primaryRole: 'family', primaryCapacity: 'scribe' });
  assert.throws(() => flow.submitCurrentSigner({ role: 'family', signingCapacity: 'scribe', typedName: '娘 花子', address: '家族住所', relationship: '長女', signatureImageDataUrl: signature }));
  const signer = flow.submitCurrentSigner({ role: 'family', signingCapacity: 'scribe', typedName: '娘 花子', address: '家族住所', relationship: '長女', recipientConsentConfirmed: true, signatureImageDataUrl: signature });
  assert.equal(flow.getSession().recipientName, '本人 太郎');
  assert.equal(flow.getSession().recipientAddress, '本人住所');
  assert.equal(signer.typedName, '娘 花子');
  assert.equal(signer.address, '家族住所');
  assert.equal(signer.signingCapacity, 'scribe');
  assert.equal(signer.declarationChecked, false);
});

test('代理人署名には代理権確認とその根拠の記録が必要', () => {
  const { SigningFlow: flow, template } = setup();
  flow.startSession(template, '利用者', null, { primaryRole: 'family', primaryCapacity: 'representative' });
  const base = { role: 'family', signingCapacity: 'representative', typedName: '長女', signatureImageDataUrl: signature };
  assert.throws(() => flow.submitCurrentSigner({ ...base, declarationChecked: true }), /代理権の根拠/);
  const signer = flow.submitCurrentSigner({ ...base, declarationChecked: true, authorityBasis: '成年後見人・登記事項証明書を確認' });
  assert.equal(signer.signingCapacity, 'representative');
  assert.equal(signer.authorityBasis, '成年後見人・登記事項証明書を確認');
});

test('利用者住所欄は署名者に紐付けずテンプレートに置ける', () => {
  const { Models: models, template } = setup();
  template.pages[0].fields.push(models.createField({ id: 'recipient-address', type: 'recipient_address', x: 50, y: 100, width: 220, height: 24 }));
  assert.deepEqual(Array.from(models.validateTemplate(template)), []);
});

test('手書き署名と利用者住所だけの書式でも、本人自署と家族代筆を完了できる', () => {
  const { Models: models, SigningFlow: flow, template } = setup();
  template.pages[0].fields.push(models.createField({ id: 'recipient-address', type: 'recipient_address', x: 50, y: 100, width: 220, height: 24 }));
  assert.deepEqual(Array.from(models.validateTemplate(template)), []);

  flow.startSession(template, '本人 太郎', null, { primaryRole: 'recipient', recipientAddress: '本人住所' });
  flow.submitCurrentSigner({ role: 'recipient', typedName: '本人 太郎', signatureImageDataUrl: signature });
  assert.equal(flow.isQueueComplete(), true);
  assert.equal(flow.getSession().recipientName, '本人 太郎');
  assert.equal(flow.getSession().recipientAddress, '本人住所');

  flow.startSession(template, '本人 太郎', null, { primaryRole: 'family', primaryCapacity: 'scribe', recipientAddress: '本人住所' });
  flow.submitCurrentSigner({ role: 'family', signingCapacity: 'scribe', typedName: '娘 花子', recipientConsentConfirmed: true, signatureImageDataUrl: signature });
  assert.equal(flow.isQueueComplete(), true);
  assert.equal(flow.getSession().recipientName, '本人 太郎');
  assert.equal(flow.getSession().signers[0].typedName, '娘 花子');
});

test('必須の利用者住所欄がある書式は、住所を入力するまで署名を開始しない', () => {
  const { Models: models, SigningFlow: flow, template } = setup();
  template.pages[0].fields.push(models.createField({ id: 'recipient-address', type: 'recipient_address', x: 50, y: 100, width: 220, height: 24 }));
  assert.throws(() => flow.startSession(template, '本人 太郎', null, { primaryRole: 'recipient' }), /利用者住所/);
  flow.startSession(template, '本人 太郎', null, { primaryRole: 'recipient', recipientAddress: '本人住所' });
  assert.equal(flow.getSession().recipientAddress, '本人住所');
});

test('任意の利用者住所欄は空欄でも署名を始められる', () => {
  const { Models: models, SigningFlow: flow, template } = setup();
  template.pages[0].fields.push(models.createField({ id: 'recipient-address', type: 'recipient_address', required: false, x: 50, y: 100, width: 220, height: 24 }));
  flow.startSession(template, '本人 太郎', null, { primaryRole: 'recipient' });
  assert.equal(flow.getSession().recipientAddress, '');
});

test('署名者住所欄が必須の時だけ、担当する署名者に住所を求める', () => {
  const { Models: models, SigningFlow: flow, template } = setup();
  template.pages[0].fields.push(models.createField({ id: 'family-address', type: 'address', linkedFieldId: 'sig', assignedRole: 'family', required: true, x: 50, y: 100, width: 220, height: 24 }));
  flow.startSession(template, '本人 太郎', null, { primaryRole: 'family', primaryCapacity: 'scribe' });
  const family = { role: 'family', signingCapacity: 'scribe', typedName: '長女 花子', recipientConsentConfirmed: true, signatureImageDataUrl: signature };
  assert.throws(() => flow.submitCurrentSigner(family), /住所/);
  flow.submitCurrentSigner({ ...family, address: '家族住所' });
  assert.equal(flow.getSession().signers[0].address, '家族住所');
});

test('家族用住所欄は本人の署名時に入力を求めない', () => {
  const { Models: models, SigningFlow: flow, template } = setup();
  template.pages[0].fields.push(models.createField({ id: 'family-address', type: 'address', linkedFieldId: 'sig', assignedRole: 'family', required: true, x: 50, y: 100, width: 220, height: 24 }));
  flow.startSession(template, '本人 太郎', null, { primaryRole: 'recipient' });
  flow.submitCurrentSigner({ role: 'recipient', typedName: '本人 太郎', signatureImageDataUrl: signature });
  assert.equal(flow.getSession().signers[0].address, null);
});

test('本人住所と本人の署名者住所は一つの値になり、署名時の訂正を両方へ反映する', () => {
  const { Models: models, SigningFlow: flow, template } = setup();
  template.pages[0].fields.push(
    models.createField({ id: 'recipient-address', type: 'recipient_address', x: 50, y: 100, width: 220, height: 24 }),
    models.createField({ id: 'signer-address', type: 'address', linkedFieldId: 'sig', x: 50, y: 140, width: 220, height: 24 }),
  );
  flow.startSession(template, '本人 太郎', null, { primaryRole: 'recipient', recipientAddress: '事業者の入力住所' });
  assert.throws(() => flow.submitCurrentSigner({ role: 'recipient', typedName: '本人 太郎', address: '', signatureImageDataUrl: signature }), /住所/);
  assert.equal(flow.getSession().recipientAddress, '事業者の入力住所');
  assert.equal(flow.getSession().signers.length, 0);
  const signer = flow.submitCurrentSigner({ role: 'recipient', typedName: '本人 太郎', address: '本人が訂正した住所', signatureImageDataUrl: signature });
  assert.equal(signer.address, '本人が訂正した住所');
  assert.equal(flow.getSession().recipientAddress, '本人が訂正した住所');
  assert.ok(flow.getSession().eventLog.some(event => event.type === 'recipient_address_updated'));
});

test('家族の住所を入力しても利用者本人の住所は変わらない', () => {
  const { Models: models, SigningFlow: flow, template } = setup();
  template.pages[0].fields.push(models.createField({ id: 'signer-address', type: 'address', linkedFieldId: 'sig', x: 50, y: 140, width: 220, height: 24 }));
  flow.startSession(template, '本人 太郎', null, { primaryRole: 'family', primaryCapacity: 'scribe', recipientAddress: '本人住所' });
  flow.submitCurrentSigner({ role: 'family', signingCapacity: 'scribe', typedName: '娘 花子', address: '娘の住所', recipientConsentConfirmed: true, signatureImageDataUrl: signature });
  assert.equal(flow.getSession().recipientAddress, '本人住所');
  assert.equal(flow.getSession().signers[0].address, '娘の住所');
});

test('必須の続柄欄がある時だけ、家族の続柄を求める', () => {
  const { Models: models, SigningFlow: flow, template } = setup();
  template.pages[0].fields.push(models.createField({ id: 'family-relationship', type: 'relationship', linkedFieldId: 'sig', required: true, x: 50, y: 100, width: 120, height: 24 }));
  flow.startSession(template, '本人 太郎', null, { primaryRole: 'family', primaryCapacity: 'scribe' });
  const family = { role: 'family', signingCapacity: 'scribe', typedName: '長女 花子', recipientConsentConfirmed: true, signatureImageDataUrl: signature };
  assert.throws(() => flow.submitCurrentSigner(family), /続柄/);
  flow.submitCurrentSigner({ ...family, relationship: '長女' });
  assert.equal(flow.getSession().signers[0].relationship, '長女');
});

test('付随項目は署名欄と記入者の役割が一致するものだけを選ぶ', () => {
  const { Models: models, template } = setup();
  template.pages[0].fields.push(
    models.createField({ id: 'family-name', type: 'name', linkedFieldId: 'sig', assignedRole: 'family', x: 50, y: 100 }),
    models.createField({ id: 'recipient-name', type: 'name', linkedFieldId: 'sig', assignedRole: 'recipient', x: 50, y: 150 }),
    models.createField({ id: 'either-name', type: 'name', linkedFieldId: 'sig', assignedRole: 'either', x: 50, y: 200 }),
  );
  assert.deepEqual(Array.from(models.getSignerFields(template, 'sig', 'family', ['name']), field => field.id), ['family-name', 'either-name']);
  assert.deepEqual(Array.from(models.getSignerFields(template, 'sig', 'recipient', ['name']), field => field.id), ['recipient-name', 'either-name']);
});

test('家族が本人名を代筆した後、次の署名に家族自身の入力情報を引き継げる', () => {
  const { Models: models, SigningFlow: flow, template } = setup();
  template.signingMode = 'all';
  template.pages[0].fields.push(models.createField({ id: 'family-sig', type: 'signature', signOrder: 2, x: 50, y: 260 }));
  flow.startSession(template, '本人 太郎', null, { primaryRole: 'family', primaryCapacity: 'scribe' });
  assert.equal(flow.getReusableScribeDetails(), null);
  flow.submitCurrentSigner({ role: 'family', signingCapacity: 'scribe', typedName: '娘 花子', address: '家族住所', relationship: '長女', recipientConsentConfirmed: true, signatureImageDataUrl: signature });
  assert.deepEqual({ ...flow.getReusableScribeDetails() }, { typedName: '娘 花子', address: '家族住所', building: '', relationship: '長女' });
  assert.equal(flow.getCurrentField().id, 'family-sig');
  assert.equal(flow.getSession().signers.length, 1);
});

test('本人自署の後は家族の入力情報を自動で引き継がない', () => {
  const { Models: models, SigningFlow: flow, template } = setup();
  template.signingMode = 'all';
  template.pages[0].fields.push(models.createField({ id: 'family-sig', type: 'signature', signOrder: 2, x: 50, y: 260 }));
  flow.startSession(template, '本人 太郎', null, { primaryRole: 'recipient' });
  flow.submitCurrentSigner({ role: 'recipient', typedName: '本人 太郎', signatureImageDataUrl: signature });
  assert.equal(flow.getReusableScribeDetails(), null);
});

test('追加の家族署名でも、家族用の住所・続柄欄を必須チェックと印字対象にできる', () => {
  const { Models: models, SigningFlow: flow, template } = setup();
  template.signingMode = 'all';
  template.pages[0].fields.push(
    models.createField({ id: 'family-sig', type: 'signature', signOrder: 2, x: 50, y: 260 }),
    models.createField({ id: 'family-address', type: 'address', assignedRole: 'family', linkedFieldId: 'family-sig', required: true, x: 50, y: 310 }),
    models.createField({ id: 'family-relationship', type: 'relationship', linkedFieldId: 'family-sig', required: true, x: 50, y: 350 }),
    models.createField({ id: 'proxy-confirmation', type: 'declaration_checkbox', assignedRole: 'family', linkedFieldId: 'family-sig', x: 50, y: 390 }),
  );
  flow.startSession(template, '本人 太郎', null, { primaryRole: 'recipient' });
  flow.submitCurrentSigner({ role: 'recipient', typedName: '本人 太郎', signatureImageDataUrl: signature });
  assert.deepEqual(Array.from(models.getSignerFields(template, 'family-sig', 'additional', ['address', 'relationship']), field => field.id), ['family-address', 'family-relationship']);
  assert.deepEqual(Array.from(models.getSignerFields(template, 'family-sig', 'additional', ['declaration_checkbox']), field => field.id), ['proxy-confirmation']);
  assert.throws(() => flow.submitCurrentSigner({ role: 'additional', typedName: '娘 花子', signatureImageDataUrl: signature }), /住所/);
  assert.throws(() => flow.submitCurrentSigner({ role: 'additional', typedName: '娘 花子', address: '家族住所', signatureImageDataUrl: signature }), /続柄/);
  flow.submitCurrentSigner({ role: 'additional', typedName: '娘 花子', address: '家族住所', relationship: '長女', confirmedDeclarationIds:['proxy-confirmation'], signatureImageDataUrl: signature });
  assert.equal(flow.getSession().signers[1].address, '家族住所');
});
