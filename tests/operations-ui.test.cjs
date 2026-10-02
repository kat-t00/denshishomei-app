const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs/promises');
const {chromium}=require('playwright');
test('途中署名をホームから再開し、破棄拒否でも保持・全画面で離脱を保護する',async()=>{
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 try{
  const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('keiyaku_welcome_seen_v1','1'));
  await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);await page.waitForFunction(()=>document.body.dataset.appReady==='true');
  await page.evaluate(async()=>{const pdf=await PDFLib.PDFDocument.create();pdf.addPage([595,842]);await TemplateStore.saveNew(Models.createTemplate({name:'中断確認',pdfBase64:await pdf.saveAsBase64(),pages:[{widthPt:595,heightPt:842,fields:[Models.createField({id:'sig',x:50,y:50})]}]}));});
  await page.locator('#btn-nav-home').click();await page.getByRole('button',{name:'これで署名する'}).click();
  await page.locator('#signing-recipient-name').fill('本人');
  await page.locator('#btn-nav-home').click();await page.locator('#btn-nav-resume').click();
  assert.equal(await page.locator('#signing-recipient-name').inputValue(),'本人');
  await page.getByRole('button',{name:'次へ進む'}).click();
  const id=await page.evaluate(async()=>SigningFlow.getSession().sessionId);
  await page.locator('#btn-nav-home').click();
  assert.equal(await page.locator('#btn-nav-resume').isVisible(),true);
  assert.equal(await page.evaluate(async()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;}),true);
  page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'これで署名する'}).click();
  assert.equal(await page.evaluate(async()=>SigningFlow.getSession().sessionId),id);
  assert.equal(await page.locator('#screen-signing').isVisible(),true);
  await page.locator('#btn-nav-home').click();await page.locator('#btn-nav-resume').click();
  assert.match(await page.locator('#signing-stage').innerText(),/端末をお渡し/);
 }finally{await browser.close();}
});
test('完成PDF確認と交付記録・担当者記録を保存し、交付記録が最終PDFを変えない',async()=>{
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 try{
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.dismiss());
  await page.addInitScript(()=>localStorage.setItem('keiyaku_welcome_seen_v1','1'));
  await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);await page.waitForFunction(()=>document.body.dataset.appReady==='true');
  await page.evaluate(async()=>{const pdf=await PDFLib.PDFDocument.create();pdf.addPage([595,842]);await TemplateStore.saveNew(Models.createTemplate({name:'交付確認',signingMode:'legacy',pdfBase64:await pdf.saveAsBase64(),pages:[{widthPt:595,heightPt:842,fields:[Models.createField({id:'sig',required:false,x:50,y:50})]}]}));});
  await page.locator('#btn-nav-home').click();await page.getByRole('button',{name:'これで署名する'}).click();
  await page.locator('#signing-recipient-name').fill('本人');await page.getByRole('button',{name:'次へ進む'}).click();
  await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=80;c.height=30;c.getContext('2d').fillRect(5,5,50,20);SigningFlow.submitCurrentSigner({role:'recipient',typedName:'本人',signatureImageDataUrl:c.toDataURL()});});
  await page.getByRole('button',{name:/ここで契約を終了/}).click();
  await page.getByLabel('事業所名', {exact:true}).fill('テスト事業所');await page.getByLabel('説明・確認した担当者名').fill('担当 太郎');
  await page.getByLabel('控えの交付方法').selectOption('electronic');
  assert.equal(await page.getByRole('button',{name:/確定してPDF/}).isEnabled(),false);
  await page.getByLabel('電子交付の方法を説明し、受け取る方の承諾を得ました').check();
  await page.getByRole('button',{name:'完成書面を確認'}).click();
  await page.getByRole('button',{name:'印字内容を確認しました'}).waitFor();
  if(process.env.OPERATIONS_SCREENSHOT) await page.screenshot({path:process.env.OPERATIONS_SCREENSHOT,fullPage:true});
  await page.getByRole('button',{name:'印字内容を確認しました'}).click();
  await page.getByRole('button',{name:/確定してPDF/}).click();
  await page.getByRole('heading',{name:'署名書類ができました'}).waitFor();
  async function download(name){const p=page.waitForEvent('download',{timeout:5000});p.catch(()=>{});await page.getByRole('button',{name,exact:true}).click({timeout:5000});try{return await fs.readFile(await(await p).path());}catch(e){throw new Error(name+' / '+await page.locator('#signing-stage').innerText()+' / '+errors.join(','));}}
  const before=await download('署名済みPDFを保存');
  const record=JSON.parse(await download('監査記録を保存'));
  assert.equal(record.operator.providerName,'テスト事業所');assert.equal(record.deliveryPlan.electronicConsent,true);
  await page.getByLabel('控えを渡した相手').fill('本人');await page.getByLabel('交付結果').selectOption('delivered');
  const receipt=JSON.parse(await download('交付記録を保存'));
  assert.equal(receipt.finalPdfHashSha256,record.finalPdfHashSha256);assert.equal(receipt.status,'delivered');
  assert.deepEqual(await download('署名済みPDFを保存'),before);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
test('訂正記録は長い理由も複数ページに残し、原本を変更しない',async()=>{
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 try {
  const page=await browser.newPage();await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);await page.waitForFunction(()=>document.body.dataset.appReady==='true');
  const result=await page.evaluate(async()=>{
    const record=VoidFlow.buildVoidRecord('a'.repeat(64),'訂正理由です。'.repeat(500),'担当者','ID');
    const bytes=await VoidFlow.buildVoidNoticePdf(record);
    const doc=await PdfUtils.loadPdf(bytes.slice().buffer);let text='';
    for(let n=1;n<=doc.numPages;n++) text+=(await(await doc.getPage(n)).getTextContent()).items.map(i=>i.str).join('');
    return {pages:doc.numPages,text,format:record.format};
  });
  assert.ok(result.pages>1);assert.match(result.text,/法的な無効/);assert.equal(result.format,'keiyaku-correction');
 }finally{await browser.close();}
});
