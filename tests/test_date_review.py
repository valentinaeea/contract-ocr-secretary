"""Date voting; readings are those measured on a real handwritten "11月19日" crop."""
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import date_review as d


def line(text):
    return {'text': text, 'x0': 100, 'x1': 1500, 'y0': 0, 'y1': 40, 'score': .993}


class DateReviewTests(unittest.TestCase):
    def run_vote(self, text, others):
        item = line(text); match = d.DATE_SPAN.search(text)
        return d.apply(item, match.start(), match.end(), others), item

    def test_handwritten_day_corrected_by_majority_and_kept_visible(self):
        status, item = self.run_vote('于2025年11月1日日由安永', ['于2025年11月19日', '于2025年11月19日由'])
        self.assertEqual(status, 'corrected'); self.assertEqual(item['text'], '于2025年11月19日由安永')
        self.assertEqual(item['alternatives'], ['于2025年11月1日日由安永'])

    def test_agreement_changes_nothing(self):
        status, item = self.run_vote('签订日期：2026年7月17日', ['2026年7月17日', '2026年7月17日'])
        self.assertEqual(status, 'kept'); self.assertNotIn('alternatives', item)

    def test_disagreement_or_invalid_marks_review(self):
        status, item = self.run_vote('2025年11月 / 日', ['2025年11月19日', '2025年11月18日'])
        self.assertEqual(status, 'review'); self.assertEqual(item['text'], '2025年11月 / 日')
        self.assertEqual(item['alternatives'], ['2025年11月19日', '2025年11月18日'])
        status, item = self.run_vote('2025年11月1日日', ['', ''])
        self.assertEqual(status, 'review'); self.assertEqual(item['alternatives'], ['日期需核对'])

    def test_parse_rejects_impossible_dates(self):
        self.assertIsNone(d.parse('2025年13月1日')); self.assertIsNone(d.parse('2025年11月1日日'))
        self.assertEqual(d.parse('于2025年11月19日由'), (2025, 11, 19))

    def test_crop_box_covers_date_inside_long_line(self):
        item = line('本工作说明书于2025年11月19日由安永（中国）企业咨询有限公司')
        match = d.DATE_SPAN.search(item['text']); x0, _, x1, _ = d.span_box(item, match.start(), match.end())
        self.assertGreater(x0, 300); self.assertLess(x1, 900); self.assertGreater(x1 - x0, 300)


if __name__ == '__main__': unittest.main()
