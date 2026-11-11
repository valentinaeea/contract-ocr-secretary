"""Completeness screening on synthetic pages, without customer documents."""
import io
from pathlib import Path
import sys
import unittest
from PIL import Image, ImageDraw
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
from page_quality import visual_signal, coverage_signal, audit_page

class PageQualityTests(unittest.TestCase):
    def png(self, marks=False):
        image=Image.new('RGB',(600,800),'white')
        if marks:
            draw=ImageDraw.Draw(image)
            draw.rectangle((60,100,400,115),fill='black')
            draw.rectangle((60,200,400,215),fill='black')
        stream=io.BytesIO();image.save(stream,format='PNG');return stream.getvalue()
    def test_blank_is_distinct_from_nonblank_without_text(self):
        blank=audit_page(1,[],visual_signal(self.png()))
        content=audit_page(2,[],visual_signal(self.png(True)))
        self.assertEqual(blank['state'],'近空白页')
        self.assertEqual(content['state'],'有图像但无识别文字')
    def test_uncovered_paragraph_is_a_signal_not_accuracy(self):
        line={'text':'synthetic','x0':60,'y0':100,'x1':400,'y1':115,'score':.9}
        uncovered=coverage_signal(self.png(True),[line],600,800)
        self.assertTrue(uncovered['uncoveredContent'])
        covered=coverage_signal(self.png(True),[line,{**line,'y0':200,'y1':215}],600,800)
        self.assertFalse(covered['uncoveredContent'])
    def test_outside_crop_boxes_do_not_fail_screening(self):
        result=coverage_signal(self.png(True),[{'x0':700,'x1':900,'y0':20,'y1':40}],600,800)
        self.assertTrue(result['uncoveredContent'])
    def test_low_score_and_retry_are_recorded(self):
        result=audit_page(3,[{'text':'synthetic','score':.5}],visual_signal(self.png(True)),True)
        self.assertEqual(result['lowScoreLines'],1)
        self.assertTrue(result['retried'])
        self.assertEqual(result['state'],'含低分文字')
if __name__=='__main__':unittest.main()
