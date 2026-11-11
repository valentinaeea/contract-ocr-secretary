"""Synthetic page geometry and original retention; never use customer documents."""
import concurrent.futures
import http.server
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import desktop
from documents import recognize_document

class DocumentLayoutTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.previous = desktop.DATA_ROOT, desktop.DB_PATH
        desktop.DATA_ROOT = self.root / 'data'
        desktop.DB_PATH = desktop.DATA_ROOT / 'state.sqlite3'
        desktop.initialize_store()

    def tearDown(self):
        desktop.DATA_ROOT, desktop.DB_PATH = self.previous
        self.temporary.cleanup()

    def test_text_pdf_keeps_page_size_line_boxes_and_text(self):
        import pymupdf as fitz
        pdf = fitz.open()
        page = pdf.new_page(width=612, height=792)
        page.insert_text((72, 90), 'AUDIT SERVICES', fontsize=18)
        page.insert_text((108, 160), 'Control evaluation', fontsize=12)
        filename = self.root / 'synthetic.pdf'
        pdf.save(filename); pdf.close()
        with patch('semantic.classify', return_value={'semanticTags': []}):
            result = recognize_document(str(filename), filename.name, 'balanced', str(self.root / 'progress.json'))
        layout = result['layoutPages'][0]
        self.assertEqual((layout['width'], layout['height']), (612, 792))
        self.assertEqual(len(layout['lines']), 2)
        self.assertAlmostEqual(layout['lines'][0]['x0'], 72, delta=1)
        self.assertAlmostEqual(layout['lines'][1]['x0'], 108, delta=1)
        self.assertIn('Control evaluation', result['rawText'])
        self.assertGreater(layout['lines'][0]['x1'], layout['lines'][0]['x0'])

    def test_scanned_pdf_maps_ocr_boxes_back_to_pdf_coordinates(self):
        import pymupdf as fitz
        pdf = fitz.open(); pdf.new_page(width=612, height=792)
        filename = self.root / 'synthetic.pdf'; pdf.save(filename); pdf.close()
        scale = 220 / 72
        line = {'text': 'SYNTHETIC OCR', 'x0': 72*scale, 'y0': 90*scale, 'x1': 250*scale, 'y1': 110*scale}
        with patch('semantic.classify', return_value={'semanticTags': []}), patch('engine.recognize_image', return_value={'text': line['text'], 'lines':[line], 'uncertain':[]}):
            result = recognize_document(str(filename), filename.name, 'balanced', str(self.root / 'progress.json'))
        actual = result['layoutPages'][0]['lines'][0]
        for key, expected in [('x0',72), ('y0',90), ('x1',250), ('y1',110)]: self.assertAlmostEqual(actual[key], expected)

    def test_empty_nonblank_page_retries_in_fine_mode(self):
        import pymupdf as fitz
        pdf=fitz.open();page=pdf.new_page(width=612,height=792)
        page.draw_rect(fitz.Rect(72,90,400,115),fill=(0,0,0))
        filename=self.root/'retry.pdf';pdf.save(filename);pdf.close()
        factor=300/72
        line={'text':'RECOVERED CONTENT','score':.95,'x0':72*factor,'y0':90*factor,'x1':400*factor,'y1':115*factor}
        with patch('semantic.classify',return_value={'semanticTags':[]}), patch('engine.recognize_image',side_effect=[{'text':'','lines':[],'uncertain':[]},{'text':line['text'],'lines':[line],'uncertain':[]}]) as recognize:
            result=recognize_document(str(filename),filename.name,'balanced',str(self.root/'progress.json'))
        self.assertEqual(recognize.call_count,2)
        self.assertEqual(recognize.call_args.args[1],'fine')
        self.assertTrue(result['pageAudit'][0]['retried'])
        self.assertEqual(result['pageAudit'][0]['characters'],16)
        self.assertAlmostEqual(result['layoutPages'][0]['lines'][0]['x0'],72)

    def test_small_crop_preserves_conflicting_number(self):
        import pymupdf as fitz
        pdf=fitz.open();page=pdf.new_page(width=612,height=792)
        page.draw_rect(fitz.Rect(72,100,180,106),fill=(0,0,0))
        filename=self.root/'small.pdf';pdf.save(filename);pdf.close()
        a=220/72;b=300/72
        initial={'text':'USD 100','score':.6,'x0':72*a,'x1':180*a,'y0':100*a,'y1':106*a}
        refined={'text':'USD 1000','score':.98,'x0':72*b,'x1':180*b,'y0':18*b,'y1':24*b}
        with patch('semantic.classify',return_value={'semanticTags':[]}),patch('engine.recognize_image',side_effect=[{'text':initial['text'],'lines':[initial],'uncertain':[initial]},{'text':refined['text'],'lines':[refined],'uncertain':[]}]):
            result=recognize_document(str(filename),filename.name,'balanced',str(self.root/'progress.json'))
        self.assertEqual(result['rawText'],'USD 100')
        self.assertEqual(result['layoutPages'][0]['lines'][0]['alternatives'],['USD 1000'])
        self.assertEqual(result['pageAudit'][0]['smallTextCrops'],1)
        self.assertEqual(result['pageAudit'][0]['alternativeLines'],1)
        self.assertEqual(result['layoutPages'][0]['rawEnd'],7)

    def test_original_bytes_require_token_and_are_deleted_with_record(self):
        original = b'%PDF-1.4 synthetic bytes only'
        job = {'id':'synthetic', 'filename':'synthetic.pdf', 'fileSize':len(original), 'createdAt':1}
        source = desktop.DATA_ROOT/'queue'/'synthetic.input'; source.write_bytes(original)
        future = concurrent.futures.Future(); future.set_result({'rawText':'SYNTHETIC'})
        desktop.finish_job(future, job, source, desktop.DATA_ROOT/'queue'/'synthetic.progress.json')
        self.assertEqual(desktop.source_path('synthetic').read_bytes(), original)
        server = http.server.ThreadingHTTPServer(('127.0.0.1',0), desktop.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        origin = f'http://127.0.0.1:{server.server_port}'
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with self.assertRaises(urllib.error.HTTPError) as blocked: opener.open(origin+'/api/source/synthetic')
            self.assertEqual(blocked.exception.code, 403)
            request = urllib.request.Request(origin+'/api/source/synthetic', headers={'X-OCR-Token':desktop.TOKEN})
            self.assertEqual(opener.open(request).read(),original)
            request = urllib.request.Request(origin+'/api/contracts',data=json.dumps({'action':'delete','id':'synthetic'}).encode(), headers={'Origin':origin,'X-OCR-Token':desktop.TOKEN,'Content-Type':'application/json'})
            opener.open(request).close()
            self.assertFalse(desktop.source_path('synthetic').exists())
        finally:
            server.shutdown(); server.server_close();thread.join()

if __name__ == '__main__': unittest.main()
