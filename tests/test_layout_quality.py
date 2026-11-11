import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
from layout_quality import arrange,small_text_regions,supplement
class LayoutQualityTests(unittest.TestCase):
    def line(self,text,x,y,w=100,h=12):return dict(text=text,x0=x,x1=x+w,y0=y,y1=y+h,score=.95)
    def test_table_keeps_rows(self):
        lines=[self.line(str(i),x,100+i*20) for i in range(4) for x in (30,330)]
        _,text,meta=arrange(lines,600,800)
        self.assertEqual(meta['alignedRows'],4);self.assertIn('0\t0',text)
    def test_columns_read_down_each_column(self):
        lines=[self.line('L'+str(i),30,100+i*30) for i in range(3)]+[self.line('R'+str(i),330,110+i*30) for i in range(3)]
        _,text,meta=arrange(lines,600,800)
        self.assertEqual(meta['readingOrder'],'分栏阅读');self.assertLess(text.index('L2'),text.index('R0'))
    def test_small_regions_bounded(self):
        regions,limited=small_text_regions([self.line('small',30,y,h=6) for y in range(40,700,80)],600,800)
        self.assertEqual(len(regions),4);self.assertTrue(limited)
    def test_conflicting_amount_not_silently_replaced(self):
        lines=[self.line('USD 100',30,100)]
        added,conflicts=supplement(lines,[self.line('USD 1000',30,100),self.line('new',30,180)])
        self.assertEqual(lines[0]['text'],'USD 100');self.assertEqual(lines[0]['alternatives'],['USD 1000']);self.assertEqual((added,conflicts),(1,1))
    def test_headers_and_footers_retained(self):
        lines,text,meta=arrange([self.line('header',20,10),self.line('body',20,200),self.line('footer',20,770)],600,800)
        self.assertEqual(meta['headerFooterLines'],2);self.assertIn('footer',text)
    def test_word_boxes_on_one_line_keep_order(self):
        # PP-OCRv5 splits "AUDIT CONTRACT" into word boxes whose tops differ by a few pixels.
        words=[dict(text='CONTRACT',x0=300,x1=520,y0=96,y1=126,score=.99),dict(text='AUDIT',x0=90,x1=270,y0=100,y1=130,score=.99),dict(text='Invoice',x0=90,x1=260,y0=180,y1=210,score=.99),dict(text='12345',x0=290,x1=420,y0=178,y1=208,score=.99)]
        lines,text,meta=arrange(words,640,400)
        self.assertEqual(text,'AUDIT CONTRACT\nInvoice 12345');self.assertEqual([l['text'] for l in lines],['AUDIT','CONTRACT','Invoice','12345']);self.assertEqual(meta['alignedRows'],0)
    def test_full_width_word_boxes_are_not_columns(self):
        words=[dict(text=w,x0=40+i*140,x1=160+i*140,y0=100+r*30,y1=118+r*30,score=.99) for r in range(4) for i,w in enumerate(['one','two','three','four'])]
        _,text,meta=arrange(words,600,800)
        self.assertEqual(meta['readingOrder'],'按行阅读');self.assertEqual(text.splitlines()[0],'one two three four')
    def test_resegmented_reread_does_not_duplicate(self):
        # Main OCR: one box; re-read splits it differently ("附录二一" + "般条款与条件").
        lines=[dict(text='附件：附录一 工作说明书；附录二一般条款与条件',x0=90,x1=660,y0=50,y1=70,score=.9)]
        added,conflicts=supplement(lines,[dict(text='附录二一',x0=380,x1=470,y0=50,y1=70,score=.9),dict(text='般条款与条件',x0=465,x1=660,y0=48,y1=74,score=.9)])
        self.assertEqual((added,conflicts),(0,0));self.assertNotIn('alternatives',lines[0]);self.assertEqual(len(lines),1)
    def test_partial_overlap_with_other_text_is_not_stacked(self):
        lines=[dict(text='附件：附录一',x0=90,x1=230,y0=50,y1=70,score=.9)]
        added,_=supplement(lines,[dict(text='附录一工作说明书',x0=150,x1=470,y0=50,y1=70,score=.9)])
        self.assertEqual(added,0);self.assertEqual(len(lines),1)
if __name__=='__main__':unittest.main()
