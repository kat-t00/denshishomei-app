// 実行: NODE_PATH=<playwrightのあるnode_modules> node --test tests/save-flow.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { chromium = null; }
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

test('保存失敗から再保存でき、PDFと監査記録を同じ内容で保持する', { skip: !chromium && 'playwright package is not installed' }, async () => {
  const root = path.resolve(__dirname, '..');
  const server = createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = path.join(root, name === '/' ? 'index.html' : name);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {});
    const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
    const errors = [];
    let downloadCount = 0;
    page.on('download', () => { downloadCount += 1; });
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => dialog.dismiss());
    await page.addInitScript(() => localStorage.setItem('keiyaku_welcome_seen_v1', '1'));
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>document.body.dataset.appReady==='true');
    await page.evaluate(async () => {
      const pdf = await PDFLib.PDFDocument.create();
      pdf.addPage([595, 842]);
      const field = Models.createField({ required: false, x: 50, y: 80 });
      await TemplateStore.saveNew(Models.createTemplate({
        name: '保存テスト', signingMode: 'legacy', pdfBase64: await pdf.saveAsBase64(),
        pages: [{ widthPt: 595, heightPt: 842, fields: [field] }],
      }));
    });
    await page.locator('#btn-nav-home').click();
    await page.getByRole('button', { name: 'これで署名する' }).click();
    await page.locator('#signing-stage input').fill('検証用利用者');
    await page.getByRole('button', { name: '次へ進む' }).click();
    // 描画デバイスの検証ではなく、署名確定後の保存を対象にする。
    await page.evaluate(async()=> {
      const canvas = document.createElement('canvas');
      canvas.width = 100; canvas.height = 40;
      const ctx = canvas.getContext('2d');
      ctx.fillRect(5, 5, 80, 20);
      SigningFlow.submitCurrentSigner({ role: 'recipient', typedName: '検証用利用者', signatureImageDataUrl: canvas.toDataURL() });
      window.originalBuild = PdfWriter.buildSignedPdf;
    });
    await page.getByRole('button', { name: /ここで契約を終了/ }).click();
    await page.getByLabel('事業所名', {exact:true}).fill('検証事業所');
    await page.getByLabel('説明・確認した担当者名').fill('検証担当者');
    await page.getByRole('button', { name: '完成書面を確認' }).click();
    await page.getByRole('button', { name: '印字内容を確認しました' }).click();
    await page.evaluate(async()=> { PdfWriter.buildSignedPdf = async () => { throw new Error('テスト用PDF生成エラー'); }; });
    await page.getByRole('button', { name: /確定してPDFを作成/ }).click();
    assert.match(await page.locator('#signing-stage').innerText(), /署名内容・交付方法の確認/);
    await page.evaluate(async()=> {
      PdfWriter.buildSignedPdf = window.originalBuild;
      window.sharedFiles=[];window.shareMode='success';
      Object.defineProperty(navigator,'canShare',{configurable:true,value:({files})=>files.every(file=>file.type==='application/pdf'||file.type==='application/json')});
      Object.defineProperty(navigator,'share',{configurable:true,value:async({files})=>{if(window.shareMode!=='success')throw new DOMException('test',window.shareMode);window.sharedFiles.push(...files);}});
    });
    await page.getByRole('button', { name: /確定してPDFを作成/ }).click();
    await page.getByRole('heading', { name: '署名書類ができました' }).waitFor({ timeout: 30000 });
    assert.doesNotMatch(await page.locator('#signing-stage').innerText(), /ダウンロードしました|ダウンロードは完了/);
    assert.equal(await page.getByRole('button', { name: '説明音声を保存' }).count(), 0);
    assert.equal(downloadCount, 0, '保存は利用者の個別操作で開始する');
    await page.getByRole('button',{name:'署名済みPDFを共有',exact:true}).click();
    await page.waitForFunction(()=>window.sharedFiles.length===1);
    assert.equal(await page.locator('#export-saved-confirm').isChecked(),false);
    await page.getByRole('button',{name:'監査記録を共有',exact:true}).click();
    await page.waitForFunction(()=>window.sharedFiles.length===2);
    await page.evaluate(()=>window.shareMode='AbortError');
    await page.getByRole('button',{name:'署名済みPDFを共有',exact:true}).click();
    await page.getByText('共有されませんでした。必要なら保存ボタンをご利用ください。',{exact:true}).waitFor();
    await page.evaluate(()=>window.shareMode='NotAllowedError');
    await page.getByRole('button',{name:'署名済みPDFを共有',exact:true}).click();
    await page.getByText(/共有できませんでした。保存ボタン/).waitFor();
    assert.equal(await page.getByRole('button',{name:'署名済みPDFを共有',exact:true}).isEnabled(),true);
    assert.equal(await page.locator('#export-saved-confirm').isChecked(),false);
    assert.equal(downloadCount,0,'共有成功・取消・失敗で自動ダウンロードしない');
    const support=await page.evaluate(()=>{const canShare=navigator.canShare;Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false});const supported=ExportModule.canShareFile({bytes:new Uint8Array([1]),name:'test.json',mimeType:'application/json'});Object.defineProperty(navigator,'canShare',{configurable:true,value:canShare});return supported;});assert.equal(support,false);

    const audioFiles = await page.evaluate(async()=> ExportModule.listArtifactFiles({
      pdfBytes: new Uint8Array([1]), auditJson: '{}', fileNameBase: '録音テスト',
      audioBytes: new Uint8Array([2]), audioMimeType: 'audio/mp4',
    }).map(file => ({ name: file.name, mimeType: file.mimeType })));
    assert.deepEqual(audioFiles.map(file => file.name), ['録音テスト.pdf', '録音テスト_監査記録.json', '録音テスト_説明音声.m4a']);
    assert.equal(audioFiles[2].mimeType, 'audio/mp4');
    const protectedBeforeSave = await page.evaluate(async()=> {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event); return event.defaultPrevented;
    });
    assert.equal(protectedBeforeSave, true);
    await page.evaluate(async()=> {
      window.originalDownload = ExportModule.downloadBlob;
      ExportModule.downloadBlob = () => { throw new Error('テスト用保存エラー'); };
    });
    await page.getByRole('button', { name: '署名済みPDFを保存', exact: true }).click();
    assert.match(await page.locator('#signing-stage').innerText(), /保存を開始できませんでした/);
    await page.evaluate(async()=> { ExportModule.downloadBlob = window.originalDownload; });
    async function download(name) {
      const pending = page.waitForEvent('download');
      await page.getByRole('button', { name, exact: true }).click();
      return fs.readFile(await (await pending).path());
    }
    const pdf = await download('署名済みPDFを保存');
    const audit = JSON.parse(await download('監査記録を保存'));
    const shared = await page.evaluate(async()=>Promise.all(window.sharedFiles.map(async f=>({name:f.name,type:f.type,bytes:Array.from(new Uint8Array(await f.arrayBuffer()))}))));
    assert.deepEqual(Buffer.from(shared[0].bytes),pdf);assert.deepEqual(JSON.parse(Buffer.from(shared[1].bytes).toString()),audit);

    assert.equal(createHash('sha256').update(pdf).digest('hex'), audit.finalPdfHashSha256);
    const pdfInfo = await page.evaluate(async bytes => {
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
      const text = await (await doc.getPage(doc.numPages)).getTextContent();
      return { pages: doc.numPages, text: text.items.map(item => item.str).join(' ') };
    }, [...pdf]);
    assert.equal(pdfInfo.pages, 2);
    assert.match(pdfInfo.text, /検証用利用者/);
    await page.locator('#btn-nav-home').click();
    await page.getByRole('button', { name: 'これで署名する' }).click();
    assert.equal(await page.getByRole('heading', { name: '署名書類ができました' }).count(), 1);
    await page.getByRole('button', { name: '直前の署名書類' }).click();
    assert.deepEqual(await download('署名済みPDFを保存'), pdf);
    assert.deepEqual(JSON.parse(await download('監査記録を保存')), audit);
    await page.getByLabel('PDFを開いて確認し、監査記録も保存しました').check();
    assert.equal(await page.evaluate(async()=> {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event); return event.defaultPrevented;
    }), false);
    assert.equal(await page.evaluate(async()=> JSON.stringify(TemplateStore.exportAll()).includes('検証用利用者')), false);
    assert.deepEqual(errors, []);
    if (process.env.SAVE_FLOW_SCREENSHOT) await page.screenshot({ path: process.env.SAVE_FLOW_SCREENSHOT, fullPage: true });
    await page.locator('#btn-nav-home').click();
    await page.getByRole('button', { name: 'これで署名する' }).click();
    assert.equal(await page.locator('#btn-nav-last-export').isVisible(), false);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
