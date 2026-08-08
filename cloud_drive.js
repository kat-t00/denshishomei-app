// Googleドライブへの直接アップロード連携。事業所自身のGoogleアカウントを使う(BYOK思想、
// Yuya側はデータもトークンも預からない)。Google Identity Services(GIS)のトークンフローだけを使い、
// 重いgapi.jsは読み込まない。アクセストークンはメモリ内のみで保持し、自動保存はしない。
//
// OAuthの性質上、file://で開いた場合やオフライン環境では機能しない(オリジンがhttp(s)である必要がある)。
// そのためisAvailable()で事前に使用可否を判定し、使えない環境ではUI自体を出さない設計にしてある。
const CloudDrive = (() => {
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file'; // このアプリが作成したファイルだけにアクセスできる、最小権限のスコープ

  // 事業所ごとに個別取得するAPIキーではなく、このアプリ自体の識別子(Client ID)。
  // Google Cloud Consoleで取得後、ここに埋める(詳細はCLAUDE.md参照)
  const CLIENT_ID = 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com';

  let gisLoadPromise = null;
  let accessToken = null; // タブを閉じたら消える(再接続は都度必要)

  function isAvailable() {
    return location.protocol !== 'file:';
  }

  function isConfigured() {
    return !CLIENT_ID.startsWith('YOUR_GOOGLE_OAUTH_CLIENT_ID');
  }

  function loadGisScript() {
    if (gisLoadPromise) return gisLoadPromise;
    gisLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = GIS_SRC;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Googleへの接続に失敗しました。インターネット接続をご確認ください。'));
      document.head.appendChild(script);
    });
    return gisLoadPromise;
  }

  // Googleアカウントへのアクセス許可をその場で求める(ポップアップでのログイン・同意画面)
  async function connect() {
    if (!isConfigured()) throw new Error('Googleドライブ連携が未設定です(開発者向け設定が必要です)');
    await loadGisScript();
    return new Promise((resolve, reject) => {
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: (resp) => {
          if (resp.error) { reject(new Error(resp.error)); return; }
          accessToken = resp.access_token;
          resolve();
        },
      });
      tokenClient.requestAccessToken();
    });
  }

  function isConnected() {
    return !!accessToken;
  }

  function disconnect() {
    if (accessToken && window.google) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
  }

  // ファイルをGoogleドライブの「マイドライブ」直下にアップロードする(multipart/related形式)
  async function uploadFile(bytes, fileName, mimeType) {
    if (!accessToken) throw new Error('Googleドライブに接続されていません');
    const boundary = 'keiyaku_' + Date.now();
    const metadata = JSON.stringify({ name: fileName });
    const head = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + metadata +
      '\r\n--' + boundary + '\r\nContent-Type: ' + mimeType + '\r\n\r\n';
    const tail = '\r\n--' + boundary + '--';
    const body = new Blob([head, bytes, tail]);

    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'multipart/related; boundary=' + boundary,
      },
      body,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error('Googleドライブへの保存に失敗しました(' + res.status + ') ' + detail);
    }
    return res.json();
  }

  return { isAvailable, isConfigured, connect, isConnected, disconnect, uploadFile };
})();
