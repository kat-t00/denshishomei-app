const {test}=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
async function withPage(run, before){
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
 try{const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('keiyaku_welcome_seen_v1','1'));if(before)await before(page);await page.goto(pathToFileURL(path.resolve(__dirname,'../index.html')).href);await run(page);}finally{await browser.close();}
}
async function ready(page){await page.waitForFunction(()=>document.body.dataset.appReady==='true');}
test('旧保存データは移行後に再読込でき、移行失敗時は旧データを保持する',async()=>{
 const legacy=JSON.stringify([{id:'old',name:'移行試験',pdfBase64:'JVBERi0xLjQK',createdAt:'2026-01-01',updatedAt:'2026-01-01',pages:[{widthPt:595,heightPt:842,fields:[]}]}]);
 await withPage(async p=>{await ready(p);assert.equal(await p.evaluate(()=>TemplateStore.get('old').name),'移行試験');assert.equal(await p.evaluate(()=>localStorage.getItem('keiyaku_templates_v1')),null);await p.reload();await ready(p);assert.equal(await p.evaluate(()=>TemplateStore.list().length),1);},p=>p.addInitScript(value=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem('keiyaku_templates_v1',value);sessionStorage.setItem('seeded','1');}},legacy));
 await withPage(async p=>{await p.locator('.storage-startup-error').waitFor();assert.equal(await p.evaluate(()=>localStorage.getItem('keiyaku_templates_v1')),legacy);},p=>p.addInitScript(value=>{localStorage.setItem('keiyaku_templates_v1',value);IDBObjectStore.prototype.put=()=>{throw new DOMException('test quota','QuotaExceededError');};},legacy));
});
test('5MBを超える4ページPDFを保存・再読込し、失敗時の原本保持と再保存を確認',async()=>withPage(async p=>{
 await ready(p);
 const result=await p.evaluate(async()=>{
  const pdf=await PDFLib.PDFDocument.create();for(let i=0;i<4;i++)pdf.addPage([595,842]);
  const payload=new Uint8Array(6*1024*1024);for(let i=0;i<payload.length;i+=65536)crypto.getRandomValues(payload.subarray(i,i+65536));await pdf.attach(payload,'sample.bin');
  const base64=await pdf.saveAsBase64();const template=Models.createTemplate({name:'4ページ',pdfBase64:base64,pages:Array.from({length:4},(_,i)=>({widthPt:595,heightPt:842,fields:i===0?[Models.createField({id:'sig',x:50,y:50})]:[]}))});
  await TemplateStore.saveNew(template);window.largeTemplateId=template.id;
  const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=()=>{throw new DOMException('forced','QuotaExceededError');};let failure;
  try{await TemplateStore.saveEdit({...template,name:'保存失敗'});}catch(e){failure=e.message;}finally{IDBObjectStore.prototype.put=put;}
  const retained=TemplateStore.get(template.id).name;await TemplateStore.saveEdit({...template,name:'再保存'});
  return {id:template.id,bytes:base64.length*3/4,failure,retained};
 });
 assert.ok(result.bytes>5*1024*1024);assert.match(result.failure,/容量.*バックアップ/s);assert.equal(result.retained,'4ページ');
 await p.reload();await ready(p);
 const saved=await p.evaluate(async id=>{const t=TemplateStore.get(id);const pdf=await PdfUtils.loadPdf(PdfUtils.base64ToArrayBuffer(t.pdfBase64));const n=pdf.numPages;await pdf.destroy();return {name:t.name,pages:t.pages.length,pdfPages:n};},result.id);
 assert.deepEqual(saved,{name:'再保存',pages:4,pdfPages:4});
}));
test('バックアップ取込みは全件検証し、署名済み原本を上書きしない',async()=>withPage(async p=>{
 await ready(p);
 const result=await p.evaluate(async()=>{
  const pdf=await PDFLib.PDFDocument.create();pdf.addPage([595,842]);const t=Models.createTemplate({name:'原本',pdfBase64:await pdf.saveAsBase64(),pages:[{widthPt:595,heightPt:842,fields:[Models.createField({id:'sig',x:50,y:50})]}]});await TemplateStore.saveNew(t);
  let rejected=0;for(const invalid of [{id:'bad',name:'不正',pages:'bad'},{...t,pages:[{...t.pages[0],fields:[{...t.pages[0].fields[0],type:'unknown'}]}]},{...t,pdfBase64:'not a PDF'}]){try{await TemplateStore.importAll([t,invalid]);}catch{rejected++;}}
  const count=TemplateStore.list().length;await TemplateStore.markSigned(t.id);const imported=await TemplateStore.importAll([{...t,name:'変更'}]);const original=TemplateStore.get(t.id);const version=await TemplateStore.saveEdit({...original,name:'新版'});
  return {rejected,count,imported,originalName:original.name,signed:original.hasSignedSessions,total:TemplateStore.exportAll().length,version:version.version,oldArchived:TemplateStore.get(t.id).isArchived};
 });assert.deepEqual(result,{rejected:3,count:1,imported:1,originalName:'原本',signed:true,total:3,version:2,oldArchived:true});
}));
test('20MBを超えるPDFは読込前に理由を表示する',async()=>withPage(async p=>{
 await ready(p);p.on('dialog',d=>d.accept());await p.locator('#btn-nav-new-template').click();
 await p.locator('#pdf-file-input').setInputFiles({name:'large.pdf',mimeType:'application/pdf',buffer:Buffer.alloc(20*1024*1024+1)});
 await p.waitForFunction(()=>document.getElementById('pdf-file-status').textContent.includes('20MB'));
 assert.equal(await p.evaluate(()=>FieldEditor.getPageCount()),0);
}));
test('保存失敗後の編集バックアップから4ページの配置を復元できる',async()=>withPage(async p=>{
 await ready(p);p.on('dialog',d=>d.accept());
 const base64=await p.evaluate(async()=>{const pdf=await PDFLib.PDFDocument.create();for(let i=0;i<4;i++)pdf.addPage([595,842]);return pdf.saveAsBase64();});
 await p.locator('#btn-nav-new-template').click();await p.locator('#pdf-file-input').setInputFiles({name:'four.pdf',mimeType:'application/pdf',buffer:Buffer.from(base64,'base64')});await p.waitForFunction(()=>FieldEditor.getPageCount()===4);
 await p.locator('#template-name-input').fill('編集中4ページ');
 await p.evaluate(()=>{FieldEditor.getPages()[3].fields.push(Models.createField({id:'last-signature',x:40,y:80}));window.originalPut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=()=>{throw new DOMException('forced','QuotaExceededError');};});
 await p.locator('#btn-save-template').click();await p.waitForFunction(()=>!document.getElementById('btn-save-template').disabled);assert.equal(await p.evaluate(()=>TemplateStore.list().length),0);
 const downloadPromise=p.waitForEvent('download');await p.locator('#btn-backup-editing-template').click();const download=await downloadPromise;const saved=await require('node:fs/promises').readFile(await download.path());const draft=JSON.parse(saved);assert.equal(draft.template.pages[3].fields[0].id,'last-signature');
 await p.evaluate(()=>IDBObjectStore.prototype.put=window.originalPut);await p.reload();await ready(p);
 await p.locator('#import-templates-input').setInputFiles({name:'draft.json',mimeType:'application/json',buffer:saved});await p.waitForFunction(()=>FieldEditor.getPageCount()===4);
 assert.equal(await p.locator('#template-name-input').inputValue(),'編集中4ページ');assert.equal(await p.evaluate(()=>FieldEditor.getPages()[3].fields[0].id),'last-signature');assert.equal(await p.evaluate(()=>TemplateStore.list().length),0);
 await p.locator('#btn-save-template').click();await p.waitForFunction(()=>TemplateStore.list().length===1);
}));
