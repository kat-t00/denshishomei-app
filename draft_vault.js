// 途中の契約を、利用者の明示操作だけで暗号化ファイルに保存する。
const DraftVault = (() => {
  const FORMAT = 'keiyaku-encrypted-draft';
  const ITERATIONS = 250000;
  const MAX_BYTES = 40 * 1024 * 1024;
  function toBase64(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i,i+8192));
    return btoa(text);
  }
  function fromBase64(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error('途中保存ファイルの形式が正しくありません。');
    const raw = atob(text); return Uint8Array.from(raw, char => char.charCodeAt(0));
  }
  async function keyFor(password, salt) {
    if (!crypto.subtle) throw new Error('暗号化に対応したブラウザでHTTPSのアプリを開いてください。');
    if (typeof password !== 'string' || password.length < 12) throw new Error('途中保存用のパスワードは12文字以上にしてください。');
    const material = await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:ITERATIONS},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }
  async function encrypt(state, password) {
    const bytes = new TextEncoder().encode(JSON.stringify(state));
    if (bytes.length > MAX_BYTES) throw new Error('途中保存の容量が40MBを超えています。録音を別途保管するか、PDFを軽量化してください。');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFor(password,salt);
    const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv},key,bytes);
    return JSON.stringify({format:FORMAT,version:1,algorithm:'AES-GCM',kdf:'PBKDF2-SHA256',iterations:ITERATIONS,
      salt:toBase64(salt),iv:toBase64(iv),ciphertext:toBase64(new Uint8Array(encrypted))});
  }
  async function decrypt(text,password) {
    if (typeof text !== 'string' || text.length > MAX_BYTES*1.4) throw new Error('途中保存ファイルの容量が対応範囲を超えています。');
    let file; try { file = JSON.parse(text); } catch (_) { throw new Error('途中保存ファイルを読み取れません。'); }
    if (!file || file.format !== FORMAT || file.version !== 1 || file.algorithm !== 'AES-GCM' || file.kdf !== 'PBKDF2-SHA256' || file.iterations !== ITERATIONS) throw new Error('未対応の途中保存ファイルです。');
    const salt = fromBase64(file.salt), iv = fromBase64(file.iv), bytes = fromBase64(file.ciphertext);
    if (salt.length !== 16 || iv.length !== 12 || bytes.length < 16) throw new Error('途中保存ファイルが破損しています。');
    const key = await keyFor(password,salt);
    try { return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv},key,bytes))); }
    catch (_) { throw new Error('パスワードが違うか、途中保存ファイルが破損・変更されています。'); }
  }
  return {encrypt,decrypt,toBase64,fromBase64};
})();
