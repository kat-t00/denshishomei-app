const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('playwright');
async function withPage(run) {
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  try {
    const page=await browser.newPage({viewport:{width:820,height:1180}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>localStorage.setItem('keiyaku_welcome_seen_v1','1'));
    await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);await page.waitForFunction(()=>document.body.dataset.appReady==='true');
    await run(page);assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
}
async function seed(page) {
  await page.evaluate(async()=>{
    for (const name of ['居宅介護支援契約書','重要事項説明書']) {
      const pdf=await PDFLib.PDFDocument.create();const sheet=pdf.addPage([595,842]);
      sheet.drawText('Care service agreement',{x:60,y:755,size:18});
      for(let y=700;y>240;y-=35)sheet.drawLine({start:{x:60,y},end:{x:530,y},thickness:.5,color:PDFLib.rgb(.75,.79,.81)});
      const fields=[Models.createField({id:Models.makeId(),x:60,y:160,width:220,height:50})];
      await TemplateStore.saveNew(Models.createTemplate({name,signingMode:'single',pdfBase64:await pdf.saveAsBase64(),pages:[{widthPt:595,heightPt:842,fields}]}));
    }
  });
  await page.locator('#btn-nav-home').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('.template-card-thumb img')].length===2 && [...document.querySelectorAll('.template-card-thumb img')].every(img=>img.complete && img.naturalWidth>0 && Number(getComputedStyle(img).opacity)>.99));
}
test('ガイドの目次から項目比較・代筆・保存を読め、閉じて操作へ戻れる',async()=>withPage(async page=>{
  await seed(page);assert.equal(await page.locator('#btn-home-resume').isDisabled(),true);
  if(process.env.USABILITY_SCREENSHOTS) await page.screenshot({path:path.join(process.env.USABILITY_SCREENSHOTS,'home-refined.png'),fullPage:true});
  await page.locator('#btn-nav-help').click();const guide=page.getByRole('dialog',{name:'使い方ガイド'});
  assert.equal(await guide.locator('details').count(),9);
  await guide.getByRole('button',{name:'3. 署名欄と氏名・住所欄の使い分け',exact:true}).click();
  assert.equal(await guide.getByRole('cell',{name:/氏名を自署/}).isVisible(),true);
  await guide.getByRole('button',{name:'5. 本人自署・家族の代筆・代理署名',exact:true}).click();
  assert.equal(await guide.getByText(/入力欄には実際に代筆する家族の名前/).isVisible(),true);
  await guide.getByRole('button',{name:'8. 中断・再開とテンプレートのバックアップ',exact:true}).click();
  assert.equal(await guide.getByText(/12文字以上のパスワード/).isVisible(),true);
  if(process.env.USABILITY_SCREENSHOTS) await page.screenshot({path:path.join(process.env.USABILITY_SCREENSHOTS,'guide-refined.png'),fullPage:true});
  await page.keyboard.press('Escape');assert.equal(await guide.count(),0);
  assert.equal(await page.locator('#btn-nav-help').evaluate(node=>node===document.activeElement),true);
  await page.locator('#btn-home-new-template').click();assert.equal(await page.locator('#screen-template-editor').isVisible(),true);
  await page.setViewportSize({width:390,height:844});await page.locator('#btn-nav-help').click();const bounds=await page.getByRole('dialog').boundingBox();assert.ok(bounds.x>=0 && bounds.x+bounds.width<=390);if(process.env.USABILITY_SCREENSHOTS)await page.screenshot({path:path.join(process.env.USABILITY_SCREENSHOTS,'guide-mobile.png'),fullPage:true});
}));
test('案内どおりにテンプレートを選んでバックアップできる',async()=>withPage(async page=>{
  await seed(page);await page.locator('#btn-export-templates').click();
  await page.getByRole('checkbox',{name:/居宅介護支援契約書/}).check();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'バックアップする',exact:true}).click();
  const data=JSON.parse(await fs.readFile(await(await download).path(),'utf8'));
  const templates=Array.isArray(data)?data:data.templates;
  assert.equal(templates.length,1);assert.equal(templates[0].name,'居宅介護支援契約書');
}));
test('端末の色設定に追従し、手動のライト・ダーク選択を再読み込み後も維持する',async()=>withPage(async page=>{
  await page.emulateMedia({colorScheme:'dark'});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await page.getByRole('button',{name:'ライト',exact:true}).click();await page.reload();await page.waitForFunction(()=>document.body.dataset.appReady==='true');
  assert.equal(await page.evaluate(async()=>document.documentElement.dataset.theme),'light');
  assert.equal(await page.getByRole('button',{name:'ライト',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'ダーク',exact:true}).click();await page.reload();await page.waitForFunction(()=>document.body.dataset.appReady==='true');
  assert.equal(await page.evaluate(async()=>document.documentElement.dataset.theme),'dark');
  await page.locator('#btn-nav-help').click();
  assert.equal(await page.getByRole('dialog').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(29, 43, 55)');
  if(process.env.USABILITY_SCREENSHOTS)await page.screenshot({path:path.join(process.env.USABILITY_SCREENSHOTS,'guide-dark.png'),fullPage:true});
  await page.getByRole('button',{name:'閉じる',exact:true}).click();await seed(page);
  if(process.env.USABILITY_SCREENSHOTS)await page.screenshot({path:path.join(process.env.USABILITY_SCREENSHOTS,'home-dark.png'),fullPage:true});
  await page.getByRole('button',{name:'これで署名する'}).first().click();await page.locator('#signing-recipient-name').fill('本人');await page.locator('#signing-primary-role').selectOption('family');await page.locator('#signing-family-capacity').selectOption('representative');await page.getByRole('button',{name:'次へ進む'}).click();await page.getByRole('button',{name:'続ける',exact:true}).click();await page.locator('.signing-field-highlight').click();
  assert.equal(await page.locator('.signing-checkbox-row').first().evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(43, 61, 75)');assert.equal(await page.locator('.signature-pad-wrap').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(255, 255, 255)');
  if(process.env.USABILITY_SCREENSHOTS)await page.screenshot({path:path.join(process.env.USABILITY_SCREENSHOTS,'representative-dark.png'),fullPage:true});
}));
test('一筆だけ取り消して残りの署名・有効判定を保ち、最後の一筆と全消去で空に戻す',async()=>withPage(async page=>{
  const result=await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=400;canvas.height=220;canvas.style.width='400px';canvas.style.height='220px';document.body.append(canvas);
    const pad=SignaturePad.create(canvas);const box=canvas.getBoundingClientRect();
    function fire(type,x,y){canvas.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'pen',button:0,clientX:box.left+x,clientY:box.top+y}));}
    function stroke(x,y){fire('pointerdown',x,y);fire('pointermove',x+100,y);fire('pointerup',x+100,y);}
    const alpha=(x,y)=>canvas.getContext('2d').getImageData(x,y,1,1).data[3];
    stroke(20,40);stroke(200,100);const before=alpha(250,100);pad.undo();
    const first={valid:pad.isValid(),canUndo:pad.canUndo(),kept:alpha(70,40),removed:alpha(250,100)};
    pad.undo();const empty={valid:pad.isValid(),canUndo:pad.canUndo(),kept:alpha(70,40)};
    stroke(20,40);pad.clear();pad.undo();const cleared={valid:pad.isValid(),canUndo:pad.canUndo(),alpha:alpha(70,40)};pad.destroy();canvas.remove();
    return {before,first,empty,cleared};
  });
  assert.ok(result.before>0);assert.equal(result.first.valid,true);assert.ok(result.first.kept>0);assert.equal(result.first.removed,0);assert.equal(result.first.canUndo,true);
  assert.deepEqual(result.empty,{valid:false,canUndo:false,kept:0});assert.deepEqual(result.cleared,{valid:false,canUndo:false,alpha:0});
}));
test('ダークのページ送り・倍率表示を読めて、ヘッダーの上下が揃う',async()=>withPage(async page=>{
 await page.getByRole('button',{name:'ダーク',exact:true}).click();await page.locator('#btn-nav-new-template').click();
 const colors=await page.evaluate(()=>Object.fromEntries(['btn-prev-page','btn-next-page','zoom-level'].map(id=>{const e=document.getElementById(id),s=getComputedStyle(e);return [id,{color:s.color,background:s.backgroundColor}];})));
 assert.equal(colors['btn-next-page'].color,'rgb(217, 231, 239)');assert.equal(colors['btn-next-page'].background,'rgb(43, 61, 75)');assert.equal(colors['zoom-level'].color,'rgb(217, 231, 239)');assert.equal(await page.locator('.zoom-control').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(37, 55, 69)');
 for(const width of [1968,820,360]){await page.setViewportSize({width,height:900});const positions=await page.evaluate(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};};return {title:box('.app-header-top h1'),credit:box('.app-credit'),nav:box('.toolbar'),theme:box('.theme-switch'),width:innerWidth,scroll:document.documentElement.scrollWidth};});assert.ok(positions.theme.top>=positions.title.bottom);assert.ok(positions.credit.bottom<=positions.nav.top);assert.ok(positions.theme.right<=width);assert.ok(positions.credit.right<=width);assert.ok(positions.nav.right<=width);if(width>600)assert.ok(Math.abs(positions.nav.top-positions.theme.top)<12);}
 await page.getByRole('button',{name:'ライト',exact:true}).click();assert.equal(await page.locator('#btn-next-page').evaluate(e=>getComputedStyle(e).color),'rgb(34, 49, 63)');
}));
