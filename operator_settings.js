// 事業所と職員の候補だけを、登録操作時に端末へ保存する。
const OperatorSettings = (() => {
  const KEY = 'keiyaku_operator_settings_v1';
  function clean(value) {
    return {providerName: String(value.providerName || '').trim().slice(0,200),
      staffNames: [...new Set((Array.isArray(value.staffNames) ? value.staffNames : [])
        .filter(name => typeof name === 'string').map(name => name.trim().slice(0,100)).filter(Boolean))].slice(0,100)};
  }
  function load() {
    try { return clean(JSON.parse(localStorage.getItem(KEY) || '{}')); }
    catch (_) { return clean({}); }
  }
  function save(value) {
    const settings = clean(value);
    try { localStorage.setItem(KEY,JSON.stringify(settings)); }
    catch (_) { throw new Error('事業所・担当者を保存できませんでした。ブラウザの保存設定をご確認ください。'); }
    return settings;
  }
  return {load,save};
})();
