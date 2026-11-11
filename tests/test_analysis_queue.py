"""Controlled futures exercise analysis/OCR isolation and stale-result rejection."""
import concurrent.futures,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
import desktop
class Pool:
    def __init__(self):self.calls=[]
    def submit(self,fn,*args):
        future=concurrent.futures.Future();self.calls.append((future,args));return future
class AnalysisQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.previous=desktop.DATA_ROOT,desktop.DB_PATH
        desktop.DATA_ROOT=Path(self.temp.name);desktop.DB_PATH=desktop.DATA_ROOT/'state.sqlite3';desktop.initialize_store();desktop.ANALYSIS_FUTURES.clear()
        self.pool=Pool();self.server=SimpleNamespace(semantic_pool=self.pool)
        desktop.put('contracts','c',{'id':'c','rawText':'service A','uploadCategory':'ey-template','reviewerNotes':'keep','knowledgeProfile':{'customTags':['manual']}})
    def tearDown(self):
        desktop.ANALYSIS_FUTURES.clear();desktop.DATA_ROOT,desktop.DB_PATH=self.previous;self.temp.cleanup()
    def current(self):return desktop.records('contracts')[0]
    def test_analysis_does_not_block_saved_ocr_or_overwrite_manual_edits(self):
        queued=desktop.queue_analysis(self.server,'c');self.assertEqual(queued['analysisStatus'],'queued');self.assertEqual(self.current()['rawText'],'service A')
        edited=self.current();edited['reviewerNotes']='new note';desktop.put('contracts','c',edited)
        self.pool.calls[0][0].set_result({'semanticTags':[{'code':'A'}],'uploadCategory':'other'})
        self.assertEqual(self.current()['analysisStatus'],'done');self.assertEqual(self.current()['reviewerNotes'],'new note');self.assertEqual(self.current()['knowledgeProfile']['customTags'],['manual']);self.assertEqual(self.current()['uploadCategory'],'ey-template')
        desktop.queue_analysis(self.server,'c');self.assertEqual(len(self.pool.calls),1)
    def test_old_analysis_cannot_overwrite_new_text_or_new_analysis(self):
        desktop.queue_analysis(self.server,'c');old=self.pool.calls[0][0]
        edited=self.current();edited['rawText']='service B';desktop.put('contracts','c',edited)
        desktop.queue_analysis(self.server,'c');new=self.pool.calls[1][0]
        new.set_result({'semanticTags':[{'code':'B'}]});old.set_result({'semanticTags':[{'code':'A'}]})
        self.assertEqual(self.current()['semanticTags'][0]['code'],'B')
    def test_failure_and_deleted_record_are_isolated(self):
        desktop.queue_analysis(self.server,'c');self.pool.calls[0][0].set_exception(RuntimeError('failed'))
        self.assertEqual(self.current()['analysisStatus'],'error');self.assertEqual(self.current()['rawText'],'service A')
        desktop.queue_analysis(self.server,'c',force=True);desktop.delete_record('contracts','c');self.pool.calls[1][0].set_result({'semanticTags':[]});self.assertEqual(desktop.records('contracts'),[])
    def test_recognition_never_invokes_semantic_model(self):
        import pymupdf as fitz
        from unittest.mock import patch
        from documents import recognize_document
        pdf=fitz.open();pdf.new_page().insert_text((40,80),'Synthetic audit service');path=desktop.DATA_ROOT/'test.pdf';pdf.save(path);pdf.close()
        with patch('semantic.classify',side_effect=AssertionError('OCR must not call analysis')):
            result=recognize_document(str(path),'test.pdf','balanced',str(desktop.DATA_ROOT/'queue'/'p.json'))
        self.assertEqual(result['analysisStatus'],'queued');self.assertIn('Synthetic',result['rawText'])

    def test_cached_job_never_submits_ocr_but_still_submits_analysis(self):
        import ocr_cache
        from unittest.mock import Mock
        identifier='cached';data=b'synthetic cached original';key=ocr_cache.cache_key(data,'balanced','test.pdf')
        ocr_cache.save(desktop.DATA_ROOT/'ocr_cache',key,{'rawText':'service original','pageCount':1,'pageAudit':[{}],'layoutPages':[{'lines':[]}],'failedPages':[],'seconds':20})
        (desktop.DATA_ROOT/'queue'/(identifier+'.input')).write_bytes(data)
        job={'id':identifier,'filename':'test.pdf','mode':'balanced','uploadCategory':'ey-template','fileSize':len(data),'createdAt':1,'status':'queued'}
        desktop.put('jobs',identifier,job);self.server.pool=Mock();desktop.submit_stored_job(self.server,job)
        self.server.pool.submit.assert_not_called();self.assertEqual(len(self.pool.calls),1)
        stored=next(c for c in desktop.records('contracts') if c['id']==identifier)
        self.assertTrue(stored['ocrCacheHit']);self.assertEqual(stored['uploadCategory'],'ey-template');self.assertEqual(stored['rawText'],'service original');self.assertEqual(stored['analysisStatus'],'queued')
