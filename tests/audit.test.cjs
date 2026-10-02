const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');

const context = vm.createContext({ crypto: webcrypto, TextDecoder, Uint8Array });
for (const file of ['hash_utils.js', 'audit.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
}
const audit = vm.runInContext('Audit', context);
const pdf = Buffer.from('%PDF-1.7\n署名済み書類のテストデータ');
const audio = Buffer.from('説明音声のテストデータ');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function session() {
  return {
    sessionId: 'sess-test', verificationId: 'verify-test', status: 'completed',
    templateId: 'tpl-test', templateFamilyId: 'family-test', templateVersion: 1,
    startedAt: '2026-09-23T01:00:00.000Z', completedAt: '2026-09-23T01:03:00.000Z',
    recipientName: '本人 太郎', recipientAddress: '本人住所はPDFにだけ残す',
    signingPlan: { primaryRole: 'family', primaryCapacity: 'scribe', includeAdditional: false, recipientAddress: '住所の重複' },
    signers: [{ signerId: 'signer-test', typedName: '代筆 花子', role: 'family', signingCapacity: 'scribe',
      recipientConsentConfirmed: true, relationship: '長女', signedAt: '2026-09-23T01:02:00.000Z',
      address: '家族住所はPDFにだけ残す', signatureImageDataUrl: 'data:image/png;base64,secret',
      remoteAccessToken: '保存しないトークン', confirmedDeclarations: ['説明を受けた'] }],
    eventLog: [{ seq: 1, at: '2026-09-23T01:00:00.000Z', type: 'session_started' },
      { seq: 2, at: '2026-09-23T01:01:00.000Z', type: 'signer_skipped', fieldId: 'sig2', reason: 'additional_not_required' }],
    hasExplanationAudio: false, explanationAudioHashSha256: null,
    userAgent: '不要な端末情報', futureSecret: '未知の機密項目',
  };
}

test('監査記録は必要項目を残し、署名画像・住所・未知の項目を複製しない', async () => {
  const source = session();
  const record = await audit.buildAuditRecord(source, pdf, '重要事項説明書');
  assert.equal(record.format, 'keiyaku-audit');
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.templateName, '重要事項説明書');
  assert.equal(record.finalPdfHashSha256, hash(pdf));
  assert.equal(record.signers[0].signingCapacity, 'scribe');
  assert.equal(record.signers[0].recipientConsentConfirmed, true);
  assert.equal(record.signers[0].relationship, '長女');
  assert.equal(record.eventLog[1].reason, 'additional_not_required');
  const text = JSON.stringify(record);
  assert.doesNotMatch(text, /住所|signatureImageDataUrl|data:image|remoteAccessToken|userAgent|futureSecret/);
  source.signers[0].confirmedDeclarations.push('後から変更');
  source.eventLog[1].reason = '後から変更';
  assert.equal(record.signers[0].confirmedDeclarations.length, 1);
  assert.equal(record.eventLog[1].reason, 'additional_not_required');
});

test('新形式と従来形式を照合でき、PDFの1バイト変更は不一致になる', async () => {
  const modern = await audit.buildAuditRecord(session(), pdf);
  const legacy = { ...session(), finalPdfHashSha256: hash(pdf).toUpperCase() };
  for (const record of [modern, legacy]) {
    const result = await audit.verifyFiles(pdf, JSON.stringify(record));
    assert.equal(result.pdf, 'match');
    assert.equal(result.legacy, record === legacy);
    assert.equal(result.audio, 'not_recorded');
    assert.equal((await audit.verifyFiles(Buffer.concat([pdf, Buffer.from('変更')]), JSON.stringify(record))).pdf, 'mismatch');
  }
});

test('音声は一致・不一致・未選択をPDFと独立して表示できる', async () => {
  const source = { ...session(), hasExplanationAudio: true, explanationAudioHashSha256: hash(audio) };
  const text = JSON.stringify(await audit.buildAuditRecord(source, pdf));
  assert.equal((await audit.verifyFiles(pdf, text)).audio, 'not_provided');
  assert.equal((await audit.verifyFiles(pdf, text, audio)).audio, 'match');
  assert.equal((await audit.verifyFiles(pdf, text, Buffer.from('別音声'))).audio, 'mismatch');
  const noAudio = JSON.stringify(await audit.buildAuditRecord(session(), pdf));
  await assert.rejects(() => audit.verifyFiles(pdf, noAudio, audio), /音声/);
});

test('壊れたJSON・別用途のJSON・未対応版・不正なハッシュを成功扱いしない', async () => {
  const valid = await audit.buildAuditRecord(session(), pdf);
  const invalid = ['{', 'null', '[]', '{}', JSON.stringify({ finalPdfHashSha256: hash(pdf) }),
    JSON.stringify({ ...valid, format: 'another-app' }),
    JSON.stringify({ ...valid, schemaVersion: 99 }),
    JSON.stringify({ ...valid, schemaVersion: undefined }),
    JSON.stringify({ ...valid, finalPdfHashSha256: 'bad' }),
    JSON.stringify({ ...valid, hasExplanationAudio: true, explanationAudioHashSha256: null }),
    JSON.stringify({ ...valid, signers: '不正' })];
  for (const text of invalid) await assert.rejects(() => audit.verifyFiles(pdf, text));
  await assert.rejects(() => audit.verifyFiles(Buffer.from('PDF以外'), JSON.stringify(valid)), /PDF/);
});

test('JSONの記載内容や両方の改変を検証できる仕組みではないことを固定する', async () => {
  const record = await audit.buildAuditRecord(session(), pdf);
  record.recipientName = 'JSONだけ変更された名前';
  assert.equal((await audit.verifyFiles(pdf, JSON.stringify(record))).pdf, 'match');
  const changed = Buffer.concat([pdf, Buffer.from('PDFも変更')]);
  record.finalPdfHashSha256 = hash(changed);
  assert.equal((await audit.verifyFiles(changed, JSON.stringify(record))).pdf, 'match');
});
