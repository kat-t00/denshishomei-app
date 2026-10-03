const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { chromium = null; }

async function withPage(run) {
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem('keiyaku_welcome_seen_v1', '1'));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../index.html')).href);await page.waitForFunction(()=>document.body.dataset.appReady==='true');
    await run(page);
  } finally { await browser.close(); }
}

test('新しい書式では代筆時の家族署名設定を選べ、対象外の署名方法では隠す', { skip: !chromium && 'playwright package is not installed' }, async()=>withPage(async page=>{
  assert.equal(await page.evaluate(async()=>TemplateStore.normalizeTemplate({id:'old',signingMode:'optional',pages:[]}).requireAdditionalForScribe),false);
  await page.locator('#btn-nav-new-template').click();
  const setting=page.locator('#scribe-additional-setting');
  assert.equal(await setting.isVisible(),false);
  await page.locator('#template-signing-mode').selectOption('optional');
  assert.equal(await setting.isVisible(),true);
  assert.equal(await page.locator('#template-require-additional-for-scribe').isChecked(),true);
  await page.locator('#template-signing-mode').selectOption('all');
  assert.equal(await setting.isVisible(),false);
}));

test('手書き署名と利用者住所だけの書式をPDFまで出力できる', { skip: !chromium && 'playwright package is not installed' }, async()=>withPage(async page=>{
  const result=await page.evaluate(async()=>{
    const pdf=await PDFLib.PDFDocument.create();pdf.addPage([595,842]);
    const template=Models.createTemplate({name:'氏名自署の書式',signingMode:'single',pdfBase64:await pdf.saveAsBase64(),pages:[{widthPt:595,heightPt:842,fields:[
      Models.createField({id:'sig',type:'signature',x:60,y:650,width:180,height:45}),
      Models.createField({id:'addr',type:'recipient_address',x:60,y:580,width:300,height:35}),
    ]}]});
    const errors=Models.validateTemplate(template);
    const canvas=document.createElement('canvas');canvas.width=180;canvas.height=45;
    const ctx=canvas.getContext('2d');ctx.strokeStyle='#111';ctx.lineWidth=3;
    ctx.beginPath();ctx.moveTo(20,20);ctx.lineTo(150,30);ctx.stroke();
    SigningFlow.startSession(template,'本人 太郎',null,{primaryRole:'recipient',recipientAddress:'東京都千代田区一丁目2番3号',recipientBuilding:'検証マンション101号室'});
    SigningFlow.submitCurrentSigner({role:'recipient',typedName:'本人 太郎',signatureImageDataUrl:canvas.toDataURL()});
    const bytes=await PdfWriter.buildSignedPdf(template,SigningFlow.getSession());
    const signed=await pdfjsLib.getDocument({data:new Uint8Array(bytes)}).promise;
    const content=await(await signed.getPage(1)).getTextContent();
    return {errors,complete:SigningFlow.isQueueComplete(),recipientName:SigningFlow.getSession().recipientName,
      text:content.items.map(item=>item.str).join(''),pageCount:signed.numPages};
  });
  assert.deepEqual(result.errors,[]);
  assert.equal(result.complete,true);
  assert.equal(result.recipientName,'本人 太郎');
  assert.match(result.text,/東京都千代田区一丁目2番3号/);
  assert.match(result.text,/検証マンション101号室/);
  assert.ok(result.pageCount>=2);
}));

test('家族が本人名を代筆した後、自分の欄にも署名し両者の住所を別々に印字できる', { skip: !chromium && 'playwright package is not installed' }, async()=>withPage(async page=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.evaluate(async()=>{
    const pdf=await PDFLib.PDFDocument.create();pdf.addPage([595,842]);
    const fields=[
      Models.createField({id:'primary',type:'signature',x:60,y:690,width:180,height:45,signOrder:1,label:'利用者本人名の署名'}),
      Models.createField({id:'extra',type:'signature',x:60,y:490,width:180,height:45,signOrder:2,label:'家族本人の署名'}),
      Models.createField({id:'recipient-address',type:'recipient_address',x:60,y:640,width:300,height:35}),
      Models.createField({id:'family-name',type:'name',linkedFieldId:'extra',assignedRole:'family',x:60,y:440,width:220,height:30}),
      Models.createField({id:'family-address',type:'address',linkedFieldId:'extra',assignedRole:'family',x:60,y:390,width:300,height:35}),
    ];
    await TemplateStore.saveNew(Models.createTemplate({name:'家族代筆後の家族署名テスト',signingMode:'optional',pdfBase64:await pdf.saveAsBase64(),pages:[{widthPt:595,heightPt:842,fields}]}));
  });
  await page.locator('#btn-nav-home').click();
  await page.getByRole('button',{name:'これで署名する'}).click();
  await page.locator('#signing-recipient-name').fill('本人 太郎');
  await page.locator('#signing-recipient-address').fill('本人の住所');
  await page.locator('#signing-primary-role').selectOption('family');
  await page.locator('#signing-family-capacity').selectOption('scribe');
  assert.equal(await page.locator('#signing-additional-choice').isVisible(),false);
  assert.match(await page.locator('#signing-stage').innerText(),/続けて同じご家族の署名も必要/);
  await page.getByRole('button',{name:'次へ進む'}).click();
  await page.getByRole('button',{name:'続ける',exact:true}).click();
  await page.locator('.signing-field-highlight').click();
  await page.getByLabel('実際に記入するご家族のお名前',{exact:true}).fill('娘 花子');
  await page.getByLabel('ご本人との関係・立場（任意）',{exact:true}).fill('長女');
  await page.getByRole('checkbox',{name:/本人が契約内容を確認して同意し/}).check();
  async function writeSignature(){
    await page.locator('#signature-canvas').scrollIntoViewIfNeeded();
    const box=await page.locator('#signature-canvas').boundingBox();
    await page.mouse.move(box.x+20,box.y+35);await page.mouse.down();
    await page.mouse.move(box.x+120,box.y+65,{steps:12});await page.mouse.up();
    await page.getByRole('button',{name:'この内容で確定する',exact:true}).click();
  }
  await writeSignature();
  assert.equal(await page.getByRole('button',{name:'別の方が署名'}).count(),0);
  await page.getByRole('button',{name:'先ほど代筆したご家族が続けて署名'}).click();
  await page.locator('.signing-field-highlight').click();
  assert.equal(await page.getByLabel(/^(お名前|署名する方のお名前)$/,{exact:true}).inputValue(),'娘 花子');
  assert.equal(await page.getByLabel('ご本人との関係・立場（任意）',{exact:true}).inputValue(),'長女');
  assert.equal(await page.getByLabel(/^(お名前|署名する方のお名前)$/,{exact:true}).isEditable(),false);
  await page.getByLabel('記入者住所（PDF印字用・必須）').fill('娘の住所');
  await page.getByLabel('記入者の建物名・部屋番号（任意）').fill('家族マンション202号室');
  await writeSignature();
  const output=await page.evaluate(async()=>{
    const session=SigningFlow.getSession();
    const bytes=await PdfWriter.buildSignedPdf(TemplateStore.get(session.templateId),session);
    const signed=await pdfjsLib.getDocument({data:new Uint8Array(bytes)}).promise;
    const content=await(await signed.getPage(1)).getTextContent();
    return {signers:session.signers.map(s=>({role:s.role,capacity:s.signingCapacity,typedName:s.typedName,address:s.address})),
      recipientAddress:session.recipientAddress,text:content.items.map(item=>item.str).join(''),addressLines:content.items.filter(item=>['娘の住所','家族マンション202号室'].includes(item.str)).map(item=>({text:item.str,y:item.transform[5]}))};
  });
  assert.deepEqual(output.signers,[
    {role:'family',capacity:'scribe',typedName:'娘 花子',address:null},
    {role:'additional',capacity:'additional',typedName:'娘 花子',address:'娘の住所'},
  ]);
  assert.equal(output.recipientAddress,'本人の住所');
  assert.match(output.text,/本人の住所/);
  assert.match(output.text,/娘の住所/);
  assert.match(output.text,/家族マンション202号室/);
  assert.equal(output.addressLines.length,2);assert.ok(output.addressLines[0].y>output.addressLines[1].y,'完成PDFは建物名を住所の次の行に印字する');
  assert.match(output.text,/娘 花子/);
  assert.deepEqual(errors,[]);
}));

test('従来テンプレートで家族を選んでも、実際に記入する家族名の入力欄が残る', { skip: !chromium && 'playwright package is not installed' }, async()=>withPage(async page=>{
  await page.evaluate(async()=>{
    const pdf=await PDFLib.PDFDocument.create();pdf.addPage([595,842]);
    const signature=Models.createField({id:'legacy-signature',type:'signature',x:60,y:650,width:160,height:40});
    await TemplateStore.saveNew(Models.createTemplate({name:'従来フローの家族名テスト',signingMode:'legacy',pdfBase64:await pdf.saveAsBase64(),pages:[{widthPt:595,heightPt:842,fields:[signature]}]}));
  });
  await page.locator('#btn-nav-home').click();
  await page.getByRole('button',{name:'これで署名する'}).click();
  await page.locator('#signing-recipient-name').fill('利用者 太郎');
  await page.getByRole('button',{name:'次へ進む'}).click();
  await page.getByRole('button',{name:'続ける',exact:true}).click();
  await page.locator('.signing-field-highlight').click();
  await page.getByRole('button',{name:/ご家族/}).click();
  assert.equal(await page.getByLabel('実際に記入するご家族のお名前').isVisible(),true);
}));

test('新しい画面で代理人が1人署名して完了し、利用者氏名は本人のまま印字する', { skip: !chromium && 'playwright package is not installed' }, async()=>withPage(async page=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.evaluate(async()=>{
    const pdf=await PDFLib.PDFDocument.create();pdf.addPage([595,842]);
    const fields=[
      Models.createField({id:'primary',type:'signature',x:60,y:650,width:160,height:40,signOrder:1,label:'契約者の署名'}),
      Models.createField({id:'extra',type:'signature',x:300,y:650,width:160,height:40,signOrder:2,label:'追加の同意'}),
      Models.createField({id:'recipient',type:'recipient_name',x:60,y:580,width:180,height:30}),
      Models.createField({id:'signer',type:'name',linkedFieldId:'primary',x:60,y:520,width:180,height:30}),
    ];
    await TemplateStore.saveNew(Models.createTemplate({name:'署名前の確認テスト',signingMode:'optional',pdfBase64:await pdf.saveAsBase64(),pages:[{widthPt:595,heightPt:842,fields}]}));
  });
  await page.locator('#btn-nav-home').click();
  await page.getByRole('button',{name:'これで署名する'}).click();
  await page.locator('#signing-stage input').fill('利用者本人');
  await page.locator('#signing-primary-role').selectOption('family');
  await page.locator('#signing-family-capacity').selectOption('representative');
  await page.locator('#signing-additional-choice').selectOption('no');
  await page.getByRole('button',{name:'次へ進む'}).click();
  assert.match(await page.locator('#signing-stage').innerText(),/署名 1 \/ 1/);
  assert.equal(await page.getByRole('button',{name:/ここで契約を終了/}).count(),0);
  await page.getByRole('button',{name:'続ける',exact:true}).click();
  await page.locator('.signing-field-highlight').click();
  await page.getByLabel('実際に記入するご家族のお名前',{exact:true}).fill('署名する家族');
  assert.equal(await page.getByLabel('ご本人との関係・立場（任意）',{exact:true}).isVisible(),true, 'PDFに続柄欄がなくても記入者情報を任意で記録できる');
  await page.getByRole('checkbox',{name:/代理人として/}).check();
  await page.getByLabel('代理権の根拠').fill('代理権を確認');
  await page.locator('#signature-canvas').scrollIntoViewIfNeeded();
  const box=await page.locator('#signature-canvas').boundingBox();
  await page.mouse.move(box.x+20,box.y+30);await page.mouse.down();
  await page.mouse.move(box.x+100,box.y+90,{steps:12});await page.mouse.up();
  await page.getByRole('button',{name:'この内容で確定する',exact:true}).click();
  assert.match(await page.locator('#signing-stage').innerText(),/追加署名：署名前に「今回は不要」/);
  await page.getByLabel('事業所名', {exact:true}).fill('テスト事業所');
  await page.getByLabel('説明・確認した担当者名').fill('担当者');
  await page.getByRole('button',{name:'完成書面を確認'}).click();
  await page.getByRole('button',{name:'印字内容を確認しました'}).click();
  await page.getByRole('button',{name:/確定してPDFを作成/}).click();
  await page.getByRole('heading',{name:'署名書類ができました'}).waitFor();
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'署名済みPDFを保存',exact:true}).click();
  const fs=require('node:fs/promises');const bytes=await fs.readFile(await(await pending).path());
  const text=await page.evaluate(async bytes=>{
    const doc=await pdfjsLib.getDocument({data:new Uint8Array(bytes)}).promise;
    const content=await(await doc.getPage(1)).getTextContent();
    return content.items.filter(item=>item.str.trim()).map(item=>({text:item.str,y:item.transform[5]}));
  },[...bytes]);
  assert.ok(text.some(item=>item.text==='利用者本人'&&item.y>580&&item.y<610));
  assert.ok(text.some(item=>item.text==='署名する家族'&&item.y>520&&item.y<550));
  assert.deepEqual(errors,[]);
}));

test('本人自署の住所を引き継ぎ、家族は同居するときだけ明示的にコピーする', { skip: !chromium && 'playwright package is not installed' }, async()=>withPage(async page=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.evaluate(async()=>{
    const pdf=await PDFLib.PDFDocument.create();pdf.addPage([595,842]);
    const fields=[
      Models.createField({id:'sig',type:'signature',x:60,y:650,width:160,height:40}),
      Models.createField({id:'recipient-address',type:'recipient_address',x:60,y:580,width:240,height:30}),
      Models.createField({id:'signer-address',type:'address',linkedFieldId:'sig',x:60,y:525,width:240,height:30}),
    ];
    await TemplateStore.saveNew(Models.createTemplate({name:'住所引継ぎテスト',signingMode:'single',pdfBase64:await pdf.saveAsBase64(),pages:[{widthPt:595,heightPt:842,fields}]}));
  });
  await page.locator('#btn-nav-home').click();
  await page.getByRole('button',{name:'これで署名する'}).click();
  await page.locator('#signing-recipient-name').fill('本人 太郎');
  await page.locator('#signing-recipient-address').fill('事業者が入れた住所');
  await page.getByRole('button',{name:'次へ進む'}).click();
  await page.getByRole('button',{name:'続ける',exact:true}).click();
  await page.locator('.signing-field-highlight').click();
  const addressInput=page.getByLabel('記入者住所（PDF印字用・必須）');
  assert.equal(await addressInput.inputValue(),'事業者が入れた住所');
  assert.equal(await page.getByRole('button',{name:'利用者本人と同じ住所を入力'}).isVisible(),false);
  await addressInput.fill('本人が直した住所');
  await page.locator('#signature-canvas').scrollIntoViewIfNeeded();
  const box=await page.locator('#signature-canvas').boundingBox();
  await page.mouse.move(box.x+25,box.y+35);await page.mouse.down();
  await page.mouse.move(box.x+125,box.y+75,{steps:12});await page.mouse.up();
  await page.getByRole('button',{name:'この内容で確定する',exact:true}).click();
  const output=await page.evaluate(async()=>{
    const session=SigningFlow.getSession();
    const bytes=await PdfWriter.buildSignedPdf(TemplateStore.get(session.templateId),session);
    const doc=await pdfjsLib.getDocument({data:new Uint8Array(bytes)}).promise;
    const text=await(await doc.getPage(1)).getTextContent();
    return {recipientAddress:session.recipientAddress,signerAddress:session.signers[0].address,
      printed:text.items.map(item=>item.str).filter(Boolean)};
  });
  assert.equal(output.recipientAddress,'本人が直した住所');
  assert.equal(output.signerAddress,'本人が直した住所');
  assert.equal(output.printed.filter(text=>text==='本人が直した住所').length,2);
  await page.locator('#btn-nav-home').click();
  await page.reload();await page.waitForFunction(()=>document.body.dataset.appReady==='true');
  await page.getByRole('button',{name:'これで署名する'}).click();
  await page.locator('#signing-recipient-name').fill('本人 太郎');
  await page.locator('#signing-recipient-address').fill('本人の住所');
  await page.locator('#signing-primary-role').selectOption('family');
  await page.locator('#signing-family-capacity').selectOption('scribe');
  await page.getByRole('button',{name:'次へ進む'}).click();
  await page.getByRole('button',{name:'続ける',exact:true}).click();
  await page.locator('.signing-field-highlight').click();
  const familyAddress=page.getByLabel('記入者住所（PDF印字用・必須）');
  assert.equal(await familyAddress.inputValue(),'');
  await page.getByRole('button',{name:'利用者本人と同じ住所を入力'}).click();
  assert.equal(await familyAddress.inputValue(),'本人の住所');
  await familyAddress.fill('家族は別住所');
  assert.equal(await familyAddress.inputValue(),'家族は別住所');
  assert.deepEqual(errors,[]);
}));

test('筆記は差分描画し、最後の座標・縮尺・中断・破棄を正しく扱う', { skip: !chromium && 'playwright package is not installed' }, async () => withPage(async page => {
  const result = await page.evaluate(async()=> {
    const canvas = document.createElement('canvas');
    canvas.width = 800; canvas.height = 400;
    canvas.style.cssText = 'width:400px;height:200px';
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');
    const segments = []; let path = [];
    const begin = ctx.beginPath.bind(ctx), move = ctx.moveTo.bind(ctx), line = ctx.lineTo.bind(ctx), stroke = ctx.stroke.bind(ctx);
    ctx.beginPath = () => { path = []; begin(); };
    ctx.moveTo = (x,y) => { path.push([x,y]); move(x,y); };
    ctx.lineTo = (x,y) => { path.push([x,y]); line(x,y); };
    ctx.stroke = () => { segments.push(path.slice()); stroke(); };
    const pad = SignaturePad.create(canvas);
    const box = canvas.getBoundingClientRect();
    function fire(type, x, y, id = 1, pointerType = 'pen') {
      const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: id, pointerType, buttons: type === 'pointerup' ? 0 : 1, clientX: box.left + x, clientY: box.top + y });
      canvas.dispatchEvent(event);
    }
    fire('pointerdown', 10,10);
    fire('pointermove', 30,30);
    fire('pointermove', 60,45);
    fire('pointerup', 90,70);
    const first = segments.slice();
    fire('pointerdown', 100,100);
    fire('pointercancel', 100,100);
    const before = segments.length;
    fire('pointermove', 150,150);
    const afterCancel = segments.length;
    pad.destroy();
    fire('pointerdown', 30,30);
    fire('pointermove', 100,100);
    return { first, before, afterCancel, afterDestroy: segments.length };
  });
  assert.deepEqual(result.first.map(s => s.at(-1)), [[60,60],[120,90],[180,140]]);
  assert.ok(result.first.every(s => s.length === 2), '過去の線を毎回描き直さない');
  assert.equal(result.before, result.afterCancel);
  assert.equal(result.before, result.afterDestroy);
}));

test('編集画面から見本PDFを作り、長い住所を欠落なく枠内に印字する', { skip: !chromium && 'playwright package is not installed' }, async () => withPage(async page => {
  await page.evaluate(async () => {
    const pdf = await PDFLib.PDFDocument.create(); const pdfPage = pdf.addPage([595,842]);
    const fields = [
      Models.createField({id:'sig',x:60,y:610,width:180,height:55}),
      Models.createField({id:'name',type:'name',linkedFieldId:'sig',x:60,y:560,width:180,height:30,fontSize:14}),
      Models.createField({id:'address',type:'address',linkedFieldId:'sig',x:60,y:465,width:180,height:75,fontSize:12}),
      Models.createField({id:'date',type:'date',linkedFieldId:'sig',x:290,y:560,width:180,height:30,fontSize:12,dateFormat:'reiwa'}),
    ];
    fields.forEach(field=>pdfPage.drawRectangle({x:field.x,y:field.y,width:field.width,height:field.height,borderWidth:0.5,borderColor:PDFLib.rgb(.5,.5,.5)}));
    await TemplateStore.saveNew(Models.createTemplate({name:'書面品質の確認',pdfBase64:await pdf.saveAsBase64(),pages:[{widthPt:595,heightPt:842,fields}]}));
  });
  await page.locator('#btn-nav-home').click();
  await page.getByRole('button',{name:'署名欄を編集',exact:true}).click();
  await page.waitForFunction(()=>FieldEditor.getPages().length===1);
  const storageBefore=await page.evaluate(async()=>localStorage.getItem('keiyaku_templates_v1'));
  await page.locator('#btn-preview-template').click();
  await page.getByRole('heading',{name:'試し印字（見本）',exact:true}).waitFor();
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'見本PDFを保存',exact:true}).click();
  const download=await downloadPromise;
  const fs=require('node:fs/promises');
  const bytes=await fs.readFile(await download.path());
  const text=await page.evaluate(async bytes=>{
    const pdf=await pdfjsLib.getDocument({data:new Uint8Array(bytes)}).promise;
    const content=await (await pdf.getPage(1)).getTextContent();
    const address=content.items.filter(item=>item.transform[5]>465 && item.transform[5]<540);
    return {all:content.items.map(i=>i.str).join(''),address:address.map(i=>i.str).join(''),bounds:address.map(i=>({x:i.transform[4],right:i.transform[4]+i.width,y:i.transform[5]}))};
  },[...bytes]);
  assert.match(text.all,/見本・契約には使用できません/);
  assert.match(text.all,/山田 太郎/);
  assert.match(text.all,/令和/);
  assert.equal(text.address,'東京都千代田区丸の内一丁目2番3号ケアマンション101号室');
  assert.ok(text.bounds.length>1);
  assert.ok(text.bounds.every(b=>b.x>=60&&b.right<=240.1&&b.y>=465&&b.y<=540));
  assert.equal(await page.evaluate(async()=>localStorage.getItem('keiyaku_templates_v1')),storageBefore);
  await page.waitForFunction(()=>document.querySelectorAll('.modal-backdrop canvas').length===2);
  if(process.env.QUALITY_PDF)await download.saveAs(process.env.QUALITY_PDF);
  if(process.env.QUALITY_SCREENSHOT){
    const image=await page.locator('.modal-backdrop canvas').first().evaluate(canvas=>canvas.toDataURL());
    await fs.writeFile(process.env.QUALITY_SCREENSHOT,Buffer.from(image.split(',')[1],'base64'));
  }
}));

test('印字が収まらない枠・ページ外配置・紐付け欠落を見逃さない', { skip: !chromium && 'playwright package is not installed' }, async () => withPage(async page => {
  const results = await page.evaluate(async () => {
    const pdf = await PDFLib.PDFDocument.create(); pdf.addPage([595,842]);
    const signature = Models.createField({ id:'sig', x:40,y:700,width:140,height:45 });
    const name = Models.createField({ type:'name', linkedFieldId:'sig', x:40,y:650,width:180,height:25 });
    const template = Models.createTemplate({name:'品質確認',pdfBase64:await pdf.saveAsBase64(),pages:[{widthPt:595,heightPt:842,fields:[signature,name]}]});
    const canvas = document.createElement('canvas'); canvas.width=120;canvas.height=30;
    canvas.getContext('2d').fillRect(5,5,100,15);
    const session = Models.createSigningSession({signers:[Models.createSigner({fieldId:'sig',typedName:'山田 太郎',signedAt:new Date().toISOString(),signatureImageDataUrl:canvas.toDataURL()})]});
    async function errorFor(change) {
      const copy=JSON.parse(JSON.stringify(template));change(copy);
      try { await PdfWriter.buildSignedPdf(copy,session);return ''; } catch(e) { return e.message; }
    }
    return {
      valid:await errorFor(()=>{}),
      narrow:await errorFor(t=>{t.pages[0].fields[1].width=10;}),
      short:await errorFor(t=>{t.pages[0].fields[1].height=4;}),
      outside:await errorFor(t=>{t.pages[0].fields[0].x=590;}),
      unlinked:await errorFor(t=>{t.pages[0].fields[1].linkedFieldId='deleted';}),
      scale:await errorFor(t=>{t.pages[0].fields[0].signatureScale=200;t.pages[0].fields[0].x=0;}),
    };
  });
  assert.equal(results.valid,'');
  for (const key of ['narrow','short','outside','unlinked','scale']) assert.notEqual(results[key],'',key);
  const rotated = await page.evaluate(async () => {
    const pdf = await PDFLib.PDFDocument.create();
    pdf.addPage([595,842]).setRotation(PDFLib.degrees(90));
    try { await PdfUtils.loadPdf(await pdf.save()); return ''; } catch(e) { return e.message; }
  });
  assert.match(rotated,/回転/);
}));
