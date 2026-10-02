const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { chromium = null; }

test('保存したPDF・JSON・音声を画面から照合し、選び直しや画面移動で結果を残さない', { skip: !chromium && 'playwright package is not installed' }, async () => {
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
    const page = await browser.newPage({ viewport: { width: 820, height: 1180 } });
    const errors = [], requests = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => localStorage.setItem('keiyaku_welcome_seen_v1', '1'));
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>document.body.dataset.appReady==='true');
    const artifacts = await page.evaluate(async () => {
      const document = await PDFLib.PDFDocument.create(); document.addPage([595, 842]);
      const template = Models.createTemplate({ name: '照合試験', pdfBase64: await document.saveAsBase64(),
        pages: [{ widthPt: 595, heightPt: 842, fields: [Models.createField({ id: 'sig', x: 40, y: 40 })] }] });
      const canvas = window.document.createElement('canvas'); canvas.width = 100; canvas.height = 40;
      canvas.getContext('2d').fillRect(5, 5, 90, 30);
      const session = Models.createSigningSession({ status: 'completed', completedAt: new Date().toISOString(),
        recipientName: '照合用 利用者', templateVersion: 1, signers: [Models.createSigner({ fieldId: 'sig',
          typedName: '照合用 利用者', signedAt: new Date().toISOString(), signatureImageDataUrl: canvas.toDataURL() })] });
      const pdfBytes = await PdfWriter.buildSignedPdf(template, session);
      const output = await ExportModule.buildSignedArtifacts(template, session, pdfBytes);
      return { pdf: Array.from(pdfBytes), json: output.auditJson };
    });
    const pdfFile = { name: '署名済み.pdf', mimeType: 'application/pdf', buffer: Buffer.from(artifacts.pdf) };
    const jsonFile = text => ({ name: '監査記録.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    const result = page.locator('#verification-result');
    async function run() { await page.getByRole('button', { name: 'ファイルを照合する', exact: true }).click(); }
    async function expectText(pattern) {
      await page.waitForFunction(({ pattern }) => new RegExp(pattern).test(document.getElementById('verification-result').textContent), { pattern });
    }
    await page.getByRole('button', { name: '保存した書類を照合', exact: true }).click();
    await run(); await expectText('照合できませんでした');
    await page.locator('#verify-pdf-input').setInputFiles(pdfFile);
    await page.locator('#verify-audit-input').setInputFiles(jsonFile(artifacts.json));
    // この時点以降、照合のための通信が発生しないことも確認する。
    page.on('request', request => requests.push(request.url()));
    await run(); await expectText('PDF：監査記録のハッシュと一致しました');
    assert.match(await result.innerText(), /本人性・契約の有効性・JSONの記載内容の正しさは確認していません/);
    assert.match(await result.innerText(), /音声の記録がありません/);
    assert.equal(await page.evaluate(async()=> document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: '/tmp/keiyaku-verification-match.png', fullPage: true });

    await page.locator('#verify-pdf-input').setInputFiles({ ...pdfFile, buffer: Buffer.concat([pdfFile.buffer, Buffer.from('変更')]) });
    assert.equal(await result.innerText(), '');
    await run(); await expectText('PDF：監査記録のハッシュと一致しません');
    await page.locator('#verify-pdf-input').setInputFiles(pdfFile);
    await page.locator('#verify-audit-input').setInputFiles(jsonFile('{'));
    await run(); await expectText('照合できませんでした');

    const record = JSON.parse(artifacts.json);
    record.recipientName = '<img src="/private-leak" onerror="window.injected=true">';
    const audio = Buffer.from('テスト音声');
    record.hasExplanationAudio = true;
    record.explanationAudioHashSha256 = createHash('sha256').update(audio).digest('hex');
    await page.locator('#verify-audit-input').setInputFiles(jsonFile(JSON.stringify(record)));
    await run(); await expectText('音声：未照合');
    assert.equal(await result.getAttribute('data-status'), 'partial');
    await result.locator('summary').click();
    assert.match(await result.innerText(), /<img src=/);
    assert.equal(await result.locator('img').count(), 0);
    assert.equal(await page.evaluate(async()=> window.injected), undefined);
    await page.locator('#verify-audio-input').setInputFiles({ name: '説明.m4a', mimeType: 'audio/mp4', buffer: audio });
    await run(); await expectText('音声：監査記録のハッシュと一致しました');
    await page.locator('#verify-audio-input').setInputFiles({ name: '別音声.m4a', mimeType: 'audio/mp4', buffer: Buffer.from('別の音声') });
    await run(); await expectText('音声：監査記録のハッシュと一致しません');
    await page.getByRole('button', { name: '音声の選択を解除', exact: true }).click();
    assert.equal(await result.innerText(), '');
    assert.equal(await page.locator('#verify-audio-input').evaluate(el => el.files.length), 0);

    // 処理中に選択が変わったとき、旧ファイルの結果を表示しない。
    await page.evaluate(async()=> {
      const original = Audit.verifyFiles;
      Audit.verifyFiles = async (...args) => {
        const output = await original(...args);
        await new Promise(resolve => { window.releaseVerification = resolve; });
        return output;
      };
    });
    await run(); await page.waitForFunction(() => window.releaseVerification);
    await page.getByRole('button', { name: '選択をクリア', exact: true }).click();
    await page.evaluate(async()=> window.releaseVerification());
    await page.waitForFunction(() => !document.getElementById('btn-verify-files').disabled);
    assert.equal(await result.innerText(), '');
    await page.locator('#verify-pdf-input').setInputFiles(pdfFile);
    await page.locator('#verify-audit-input').setInputFiles(jsonFile(artifacts.json));
    await page.getByRole('button', { name: 'ホームに戻る', exact: true }).click();
    await page.getByRole('button', { name: '保存した書類を照合', exact: true }).click();
    assert.equal(await page.locator('#verify-pdf-input').evaluate(el => el.files.length), 0);
    assert.equal(await page.locator('#verify-audit-input').evaluate(el => el.files.length), 0);
    assert.equal(await result.innerText(), '');
    assert.equal(await page.evaluate(async()=> JSON.stringify(localStorage).includes('照合用 利用者')), false);
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
