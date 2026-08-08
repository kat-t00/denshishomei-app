// ファイルの改ざん検知に使うSHA-256ハッシュ計算。
// crypto.subtle はセキュアコンテキストが必要だが、file://で開いた場合も
// ブラウザ側でセキュアコンテキスト扱いになることをスパイクテストで確認済み。
const HashUtils = (() => {
  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  return { sha256Hex };
})();
