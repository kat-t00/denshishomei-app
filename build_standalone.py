#!/usr/bin/env python3
"""index.html・style.css・各.jsファイル・lib/以下のライブラリ一式を1つのHTMLファイルに
まとめてkeiyaku_standalone.html（配布用）とkeiyaku_事務所用.html（事業所内部利用用、
X（Twitter）への動線を含まない別内容）を作る。

以前はlib/以下(pdf.js・pdf-lib・fontkit・フォント。合計約10MB)を容量の大きさを理由に
インライン化せず<script src="lib/...">のまま外部参照にしていたが、
「HTMLファイル単体だけをコピーして別端末で使う」運用で
lib/フォルダを一緒にコピーし忘れる事故が実際に発生したため、
他の兄弟アプリと同じく完全に1ファイルへ埋め込む方式に変更した(2026/8/6)。
出力ファイルは10MB程度になるが、タブレットへのローカルコピーやメール添付は問題ない範囲。

開発（Claude Codeでの編集）は引き続きindex.html等の個別ファイルで行い、
変更したら最後にこのスクリプトを実行して両方を作り直す。

実行方法: python3 build_standalone.py
"""
import re
from pathlib import Path

BASE_DIR = Path(__file__).parent
INDEX_HTML = BASE_DIR / "index.html"
OUTPUT_HTML = BASE_DIR / "keiyaku_standalone.html"
OUTPUT_HTML_OFFICE = BASE_DIR / "keiyaku_事務所用.html"

JS_FILES = [
    "models.js",
    "pdf_utils.js",
    "hash_utils.js",
    "template_store.js",
    "field_editor.js",
    "forms.js",
    "signature_pad.js",
    "audio_recorder.js",
    "signing_flow.js",
    "pdf_writer.js",
    "audit.js",
    "export.js",
    "void_flow.js",
    "app.js",
]

# lib/以下も同じ方法でインライン化する(拡張子.jsのUMDバンドル・埋め込みデータなので、
# 上のJS_FILESと全く同じ<script>タグ差し替えで問題なく動く)
LIB_FILES = [
    "lib/pdf.min.js",
    "lib/pdf_worker_src.js",
    "lib/pdf-lib.min.js",
    "lib/fontkit.umd.min.js",
    "lib/fonts/notosansjp_base64.js",
]

# ヘッダー右上のXへの動線(app-credit)を丸ごと取り除くための正規表現。
# 事業所内部利用版では、外部SNSへの動線を含めない方針のため除去する。
APP_CREDIT_PATTERN = re.compile(
    r'\s*<a class="app-credit"[\s\S]*?</a>\n?'
)


def build_base_html():
    html = INDEX_HTML.read_text(encoding="utf-8")

    css_content = (BASE_DIR / "style.css").read_text(encoding="utf-8")
    html = html.replace(
        '<link rel="stylesheet" href="style.css" />',
        f"<style>\n{css_content}\n</style>",
    )

    for js_file in JS_FILES + LIB_FILES:
        js_content = (BASE_DIR / js_file).read_text(encoding="utf-8")
        html = html.replace(
            f'<script src="{js_file}"></script>',
            f"<script>\n{js_content}\n</script>",
        )

    # 本当に1ファイルだけで完結しているか確認する(<script src>が1個でも残っていたら
    # 「別端末にコピーする時にlibフォルダを忘れる」事故がまた起こり得るため厳密にチェックする)
    remaining = re.findall(r'<script src="([^"]+\.js)"></script>', html)
    if remaining:
        raise RuntimeError(f"インライン化されずに残っている<script src>があります: {remaining}")
    if '<link rel="stylesheet"' in html:
        raise RuntimeError("style.cssへのlinkタグが置換されずに残っています。")

    return html


def main():
    html = build_base_html()
    OUTPUT_HTML.write_text(html, encoding="utf-8")
    print(f"作成しました: {OUTPUT_HTML}")

    if not APP_CREDIT_PATTERN.search(html):
        raise RuntimeError("app-creditリンクが見つかりませんでした。index.htmlの構造が変わっていないか確認してください。")
    office_html = APP_CREDIT_PATTERN.sub("\n", html, count=1)
    OUTPUT_HTML_OFFICE.write_text(office_html, encoding="utf-8")
    print(f"作成しました: {OUTPUT_HTML_OFFICE}（Xへの動線なし）")

    size_mb = OUTPUT_HTML.stat().st_size / (1024 * 1024)
    print(f"このHTMLファイル単体で完結しています(約{size_mb:.1f}MB)。libフォルダは不要です。")


if __name__ == "__main__":
    main()
