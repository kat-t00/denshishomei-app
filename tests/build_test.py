"""単一HTMLを端末へコピーしたときに外部JSが必要にならないことを確認。"""
import importlib.util
from pathlib import Path
import re
import unittest

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build', root / 'build_standalone.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class StandaloneTest(unittest.TestCase):
    def test_all_scripts_are_embedded(self):
        html = build.build_base_html()
        self.assertEqual(re.findall(r'<script\b[^>]*\bsrc=', html), [])
        self.assertIn('async function finalizeSigning()', html)


if __name__ == '__main__':
    unittest.main()
