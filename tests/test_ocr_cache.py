import io,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
import ocr_cache
class OCRCacheTests(unittest.TestCase):
    def test_mode_and_bytes_boundaries_cache_only_recognition(self):
        with tempfile.TemporaryDirectory() as root:
            key=ocr_cache.cache_key(b'A','balanced','a.pdf');self.assertEqual(key,ocr_cache.cache_key(b'A','balanced','renamed.pdf'));self.assertNotEqual(key,ocr_cache.cache_key(b'A','fine','a.pdf'));self.assertNotEqual(key,ocr_cache.cache_key(b'B','balanced','a.pdf'))
            result={'rawText':'OCR original','pageCount':1,'pageAudit':[{}],'layoutPages':[{'lines':[]}],'failedPages':[],'seconds':10,'semanticTags':['must not cache'],'reviewerNotes':'must not cache','uploadCategory':'ey-template'}
            ocr_cache.save(root,key,result);reused=ocr_cache.load(root,key)
            self.assertTrue(reused['ocrCacheHit']);self.assertEqual(reused['seconds'],0);self.assertEqual(reused['originalRecognitionSeconds'],10);self.assertNotIn('semanticTags',reused);self.assertNotIn('reviewerNotes',reused);self.assertNotIn('uploadCategory',reused)
            result['failedPages']=[1];ocr_cache.save(root,'bad',result);self.assertIsNone(ocr_cache.load(root,'bad'))
            (Path(root)/(key+'.json')).write_text('broken');self.assertIsNone(ocr_cache.load(root,key))
    def test_ppm_transport_preserves_every_pixel(self):
        import pymupdf as fitz
        from PIL import Image,ImageChops
        pdf=fitz.open();p=pdf.new_page();p.insert_text((40,80),'Small text 180,000.25');pix=p.get_pixmap(matrix=fitz.Matrix(3,3),alpha=False)
        a=Image.open(io.BytesIO(pix.tobytes('png'))).convert('RGB');b=Image.open(io.BytesIO(pix.tobytes('ppm'))).convert('RGB')
        self.assertIsNone(ImageChops.difference(a,b).getbbox());pdf.close()
