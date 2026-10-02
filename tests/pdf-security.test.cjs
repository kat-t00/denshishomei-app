const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('読み込んだPDFからの動的コード生成を許可しない', async () => {
  let options;
  const context = vm.createContext({
    Blob, URL, PDF_WORKER_SOURCE: '',
    pdfjsLib: {
      GlobalWorkerOptions: {},
      getDocument(input) {
        options = input;
        return { promise: Promise.resolve({ numPages: 0 }) };
      },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'pdf_utils.js'), 'utf8'), context);
  await vm.runInContext('PdfUtils.loadPdf(new Uint8Array([1, 2, 3]))', context);
  assert.equal(options.isEvalSupported, false);
  URL.revokeObjectURL(context.pdfjsLib.GlobalWorkerOptions.workerSrc);
});
