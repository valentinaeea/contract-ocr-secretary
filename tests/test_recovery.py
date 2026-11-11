"""Failure recovery and data protection, synthetic files only."""
import concurrent.futures
import http.server
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
import zipfile
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
import desktop
import documents
from recovery import PageCheckpoint

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.previous=desktop.DATA_ROOT,desktop.DB_PATH
        desktop.DATA_ROOT=self.root/'data';desktop.DB_PATH=desktop.DATA_ROOT/'state.sqlite3'
        desktop.initialize_store();desktop.JOB_SAVE_ERRORS.clear()
        self.progress=desktop.DATA_ROOT/'queue'/'synthetic.progress.json'
    def tearDown(self):
        desktop.DATA_ROOT,desktop.DB_PATH=self.previous;desktop.JOB_SAVE_ERRORS.clear();self.tmp.cleanup()
    def pdf(self):
        import pymupdf as fitz
        doc=fitz.open()
        for n in range(1,4):doc.new_page().insert_text((72,90),'SYNTHETIC PAGE '+str(n))
        source=self.root/'synthetic.pdf';doc.save(source);doc.close();return source
    def test_only_failed_page_is_reprocessed(self):
        source=self.pdf();original=documents.recognize_pdf_page;calls=[]
        def fail(page,n,*args):
            calls.append(n)
            if n==2:raise ValueError('synthetic damaged page')
            return original(page,n,*args)
        with patch('semantic.classify',return_value={'semanticTags':[]}),patch('documents.recognize_pdf_page',fail):
            result=documents.recognize_document(str(source),source.name,'balanced',str(self.progress))
        self.assertEqual(calls,[1,2,3]);self.assertEqual(result['failedPages'],[2])
        calls=[]
        def fixed(page,n,*args):calls.append(n);return original(page,n,*args)
        with patch('semantic.classify',return_value={'semanticTags':[]}),patch('documents.recognize_pdf_page',fixed):
            result=documents.recognize_document(str(source),source.name,'balanced',str(self.progress))
        self.assertEqual(calls,[2]);self.assertEqual(result['resumedPages'],2);self.assertEqual(result['failedPages'],[])
        self.assertIn('SYNTHETIC PAGE 2',result['rawText']);self.assertEqual(len(result['pageAudit']),3)
        for page in result['layoutPages']:
            self.assertTrue(result['rawText'][page['rawStart']:page['rawEnd']].startswith('SYNTHETIC'))
    def test_interruption_preserves_checkpoint(self):
        source=self.pdf();original=documents.recognize_pdf_page
        def interrupt(page,n,*args):
            if n==2:
                self.progress.with_suffix('.cancel').write_text('cancel')
                raise RuntimeError('TASK_CANCELLED')
            return original(page,n,*args)
        with patch('semantic.classify',return_value={'semanticTags':[]}),patch('documents.recognize_pdf_page',interrupt):
            with self.assertRaisesRegex(RuntimeError,'TASK_CANCELLED'):documents.recognize_document(str(source),source.name,'balanced',str(self.progress))
        self.assertIsNotNone(PageCheckpoint(self.progress,source.read_bytes(),'balanced').load(1))
        self.progress.with_suffix('.cancel').unlink()
        with patch('semantic.classify',return_value={'semanticTags':[]}):
            result=documents.recognize_document(str(source),source.name,'balanced',str(self.progress))
        self.assertEqual(result['resumedPages'],1)
    def test_incomplete_checkpoint_is_ignored(self):
        cache=PageCheckpoint(self.progress,b'input','balanced');cache.save(1,{'text':'incomplete'})
        self.assertIsNone(cache.load(1))

    def test_changed_input_does_not_reuse_checkpoint(self):
        first=PageCheckpoint(self.progress,b'first','balanced');first.save(1,{'text':'old'})
        self.assertIsNone(PageCheckpoint(self.progress,b'changed','balanced').load(1))
        self.assertIsNone(PageCheckpoint(self.progress,b'first','fine').load(1))
    def test_startup_preserves_interrupted_input(self):
        source=desktop.DATA_ROOT/'queue'/'interrupted.input';source.write_bytes(b'synthetic')
        desktop.put('jobs','interrupted',{'id':'interrupted','status':'queued','filename':'synthetic.pdf','mode':'balanced'})
        desktop.initialize_store()
        self.assertTrue(source.exists());self.assertEqual(desktop.records('jobs')[0]['status'],'interrupted')
    def test_save_failure_preserves_input_for_retry(self):
        source=desktop.DATA_ROOT/'queue'/'save.input';source.write_bytes(b'synthetic')
        job={'id':'save','status':'queued','filename':'synthetic.pdf','fileSize':9,'createdAt':1}
        desktop.put('jobs','save',job)
        future=concurrent.futures.Future();future.set_result({'rawText':'synthetic','failedPages':[]})
        original=desktop.put
        def full(table,*args):
            if table=='contracts':raise OSError('synthetic disk full')
            return original(table,*args)
        with patch('desktop.put',full):desktop.finish_job(future,job,source,self.progress)
        self.assertTrue(source.exists());stored=desktop.records('jobs')[0]
        self.assertEqual(stored['status'],'error');self.assertTrue(stored['retryAvailable'])
    def test_cancelled_partial_result_does_not_become_retryable(self):
        source=desktop.DATA_ROOT/'queue'/'cancel.input';source.write_bytes(b'synthetic')
        job={'id':'cancel','status':'cancelling','cancelRequested':True,'filename':'synthetic.pdf'}
        desktop.put('jobs','cancel',job)
        future=concurrent.futures.Future();future.set_result({'rawText':'partial','failedPages':[2]})
        desktop.finish_job(future,job,source,self.progress)
        saved=desktop.records('jobs')[0]
        self.assertEqual(saved['status'],'cancelled');self.assertFalse(saved['retryAvailable']);self.assertFalse(source.exists())

    def test_current_web_assets_bypass_stale_browser_cache(self):
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),desktop.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        origin=f'http://127.0.0.1:{server.server_port}'
        try:
            html=opener.open(origin+'/').read().decode('utf-8')
            for asset in ['js/app.js','js/vault.js','js/vault-model.js','js/contract-facts.js','js/domain-catalog.js']:
                self.assertIn(asset+'?v='+desktop.VERSION,html)
                request=urllib.request.Request(origin+'/'+asset+'?v='+desktop.VERSION,headers={'If-Modified-Since':'Wed, 31 Dec 2099 23:59:59 GMT','If-None-Match':'old-script'})
                with opener.open(request) as response:
                    self.assertEqual(response.status,200)
                    self.assertIn('no-store',response.headers['Cache-Control'])
                    self.assertEqual(response.headers.get_content_type(),'application/javascript')
                    self.assertTrue(response.read())
        finally:server.shutdown();server.server_close();thread.join()

    def test_retry_preserves_manual_annotations(self):
        existing={'id':'same','rawText':'corrected','rawTextEditedAt':1,'reviewerNotes':'note','serviceSummary':'manual','manualFieldsEditedAt':1,'amount':100,'knowledgeProfile':{'customTags':['synthetic'],'notes':'private note'},'semanticTags':[{'code':'old'}]}
        merged=desktop.merge_recovered(existing,{'id':'same','rawText':'new OCR','amount':200,'needsExtraction':True,'semanticTags':[],'knowledgeProfile':{}})
        self.assertEqual(merged['rawText'],'corrected');self.assertEqual(merged['recoveredOCRText'],'new OCR')
        self.assertEqual(merged['reviewerNotes'],'note');self.assertEqual(merged['amount'],100);self.assertFalse(merged['needsExtraction']);self.assertEqual(merged['knowledgeProfile'],existing['knowledgeProfile'])
    def test_backup_and_duplicate_import_preserve_saved_data(self):
        contract={'id':'saved','rawText':'SYNTHETIC','reviewerNotes':'keep note','ocrRevision':'current'}
        desktop.put('contracts','saved',contract);desktop.save_source('saved',b'original synthetic')
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),desktop.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        origin=f'http://127.0.0.1:{server.server_port}'
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        headers={'Origin':origin,'X-OCR-Token':desktop.TOKEN,'Content-Type':'application/json'}
        try:
            request=urllib.request.Request(origin+'/api/backup',data=b'',headers=headers)
            data=opener.open(request).read()
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                self.assertIsNone(archive.testzip())
                self.assertEqual(archive.read('sources/'+desktop.source_path('saved').name),b'original synthetic')
                restored=json.loads(archive.read('contracts/'+desktop.record_path('contracts','saved').name))
                self.assertEqual(restored['reviewerNotes'],'keep note')
            request=urllib.request.Request(origin+'/api/contracts',data=json.dumps({'action':'batch','contracts':[{'id':'saved','reviewerNotes':'overwrite'}]}).encode(),headers=headers)
            opener.open(request).close();self.assertEqual(desktop.records('contracts')[0]['reviewerNotes'],'keep note')
            request=urllib.request.Request(origin+'/api/contracts',data=json.dumps({'action':'update','contract':{'id':'saved','reviewerNotes':'stale','ocrRevision':'old'}}).encode(),headers=headers)
            with self.assertRaises(urllib.error.HTTPError) as caught:opener.open(request)
            self.assertEqual(caught.exception.code,409)
        finally:server.shutdown();server.server_close();thread.join()
if __name__=='__main__':unittest.main()
