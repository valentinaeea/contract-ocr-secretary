"""Model profile selection, fallback and key-content prioritisation; synthetic data only."""
from pathlib import Path
import sys
import tempfile
import types
import numpy  # imported before sys.modules is patched in setUp
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import engine
import ocr_cache
from layout_quality import key_content, small_text_regions


class FakeRapidOCR:
    created = []
    def __init__(self, **options):
        self.options = options; FakeRapidOCR.created.append(options)
        self.text_det = types.SimpleNamespace(mean=None, std=None)
        self.calls = []
    def __call__(self, array, **kwargs):
        self.calls.append(kwargs)
        return [([[0, 0], [90, 0], [90, 20], [0, 20]], '2026年11月6日', 0.21)], None


class ModelProfileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.patches = [patch.object(engine, 'MODEL_ROOT', self.root), patch.object(engine, 'ENGINES', {}), patch.object(engine, '_guard', lambda: None)]
        for item in self.patches: item.start()
        FakeRapidOCR.created.clear()
        fake = types.ModuleType('rapidocr_onnxruntime'); fake.RapidOCR = FakeRapidOCR
        det = types.ModuleType('rapidocr_onnxruntime.ch_ppocr_det.utils'); det.DetPreProcess = lambda *a: a
        self.modules = patch.dict(sys.modules, {'rapidocr_onnxruntime': fake, 'rapidocr_onnxruntime.ch_ppocr_det': types.ModuleType('x'), 'rapidocr_onnxruntime.ch_ppocr_det.utils': det})
        self.modules.start()

    def tearDown(self):
        self.modules.stop()
        for item in self.patches: item.stop()
        self.tmp.cleanup()

    def install(self):
        for name in engine.FILES.values(): (self.root / name).write_bytes(b'synthetic')

    def test_whole_pages_always_use_bundled_v4(self):
        import numpy as np
        for mode in ('fast', 'balanced', 'fine'): engine.recognize_image(np.zeros((30, 100, 3), 'uint8'), mode)
        self.install()
        for mode in ('fast', 'balanced', 'fine'): result = engine.recognize_image(np.zeros((30, 100, 3), 'uint8'), mode)
        self.assertEqual(len(FakeRapidOCR.created), 1); self.assertNotIn('rec_model_path', FakeRapidOCR.created[0])
        self.assertEqual(result['ocrModel'], 'PP-OCRv4 mobile')
        self.assertEqual([engine.model_tag(m) for m in ('fast', 'balanced', 'fine')], ['v4', 'v4+datevote', 'v4+v5server+datevote'])

    def test_int8_detector_used_only_when_built_and_not_disabled(self):
        import numpy as np, os
        (self.root / engine.INT8_DET).write_bytes(b'synthetic')
        engine.recognize_image(np.zeros((30, 100, 3), 'uint8'), 'balanced')
        self.assertTrue(FakeRapidOCR.created[-1]['det_model_path'].endswith('ppocrv4_det_int8.onnx'))
        self.assertIn('+int8det', engine.model_tag('balanced'))
        os.environ['CONTRACT_OCR_INT8_DET'] = '0'
        try: self.assertIsNone(engine.int8_detector()); self.assertNotIn('+int8det', engine.model_tag('fast'))
        finally: del os.environ['CONTRACT_OCR_INT8_DET']

    def test_server_recognizer_only_reads_crops(self):
        self.install()
        FakeRapidOCR.text_rec = lambda self, crops: ([('提供S0C2报告', .93) for _ in crops], 0.0)
        try:
            self.assertEqual(engine.recognize_lines([numpy.zeros((40, 300, 3), 'uint8')]), [('提供SOC2报告', .93)])
        finally:
            del FakeRapidOCR.text_rec
        self.assertTrue(FakeRapidOCR.created[-1]['rec_model_path'].endswith('ppocrv5_rec_server.onnx'))
        self.assertEqual(engine.recognize_lines([]), [])

    def test_letter_digit_confusions_fixed_without_touching_codes(self):
        cases = {'提供S0C2类型二报告': '提供SOC2类型二报告', 'IS027001': 'ISO27001', '依据IS0 27001': '依据ISO 27001', '人民币18O,000.00元': '人民币180,000.00元', 'Page 1l of 15': 'Page 11 of 15', '180.000.00元': '180,000.00元', 'C0BIT 2019': 'COBIT 2019',
                 'XBar V50 Kit, W70, B8650, Exx30A': 'XBar V50 Kit, W70, B8650, Exx30A', '版本1.0.0': '版本1.0.0', 'CO2排放': 'CO2排放', '1,234.56': '1,234.56', 'ISO 27001：2022': 'ISO 27001:2022', '人民币180，000元': '人民币180,000元', '第1，2条': '第1，2条'}
        for raw, expected in cases.items(): self.assertEqual(engine.fix_confusables(raw), expected, raw)

    def test_low_score_handwriting_is_kept_and_flagged(self):
        import numpy as np
        result = engine.recognize_image(np.zeros((30, 100, 3), 'uint8'), 'balanced')
        self.assertLess(engine.ENGINES['v4'].calls[0]['text_score'], .3)
        self.assertEqual(result['text'], '2026年11月6日'); self.assertEqual(len(result['uncertain']), 1)

    def test_results_from_other_model_sets_are_not_reused(self):
        before = ocr_cache.cache_key(b'A', 'balanced', 'a.pdf')
        self.install()
        self.assertNotEqual(before, ocr_cache.cache_key(b'A', 'balanced', 'a.pdf'))


class KeyContentTests(unittest.TestCase):
    def line(self, text, y, score):
        return {'text': text, 'x0': 30, 'x1': 300, 'y0': y, 'y1': y + 14, 'score': score}

    def test_dates_and_amounts_are_recognised(self):
        for text in ['2026年11月6日', '____年__月__日', '签订日期：', '2026-11-06', '人民币180,000.25元', '二〇二六年十一月六日']:
            self.assertTrue(key_content(text), text)
        for text in ['服务内容', '第三条 保密义务']:
            self.assertFalse(key_content(text), text)

    def test_patches_only_for_weak_lines_dates_use_vote(self):
        lines = [self.line('模糊正文', y, .5) for y in (100, 300, 500)] + [self.line('2026年1l月6日', 700, .85)]
        regions, limited = small_text_regions(lines, 600, 800, 2)
        self.assertTrue(limited); self.assertEqual(len(regions), 2)
        self.assertFalse(any(region[1] <= 700 <= region[3] for region in regions), 'dates are handled by the date vote')
        self.assertLess(regions[0][1], regions[1][1], 'regions stay in reading order')

    def test_confident_dates_are_not_reprocessed(self):
        regions, _ = small_text_regions([self.line('2026年11月6日', 100, .97)], 600, 800, 2)
        self.assertEqual(regions, [])


if __name__ == '__main__': unittest.main()
