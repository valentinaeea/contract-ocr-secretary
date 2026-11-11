"""Version-checked persisted rule results, using synthetic records only."""
import http.server,json,sys,tempfile,threading,unittest,urllib.request,urllib.error
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
import desktop
class BusinessSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.previous=desktop.DATA_ROOT,desktop.DB_PATH
        desktop.DATA_ROOT=Path(self.temp.name);desktop.DB_PATH=desktop.DATA_ROOT/'state.sqlite3';desktop.initialize_store()
        self.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),desktop.Handler);self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start();self.origin=f'http://127.0.0.1:{self.server.server_port}'
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        desktop.put('contracts','c',{'id':'c','rawText':'Synthetic original','analysisRequest':'request','ocrRevision':'revision','analysisStatus':'done','managedBusinessAnalysis':True,'ruleAnalysisStatus':'queued','manualFieldsEditedAt':1,'amountManuallyEdited':True,'amount':180000,'projectName':'Manual project','reviewerNotes':'keep note','knowledgeProfile':{'customTags':['keep tag']}})
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();desktop.DATA_ROOT,desktop.DB_PATH=self.previous;self.temp.cleanup()
    def post(self,payload):
        request=urllib.request.Request(self.origin+'/api/business-analysis',data=json.dumps(payload).encode(),headers={'Origin':self.origin,'X-OCR-Token':desktop.TOKEN,'Content-Type':'application/json'})
        try:
            with self.opener.open(request) as response:return response.status,json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:return error.code,json.loads(error.read())
    def payload(self):return {'id':'c','request':'request','revision':'revision','snapshot':{'schema':1,'request':'request','revision':'revision','content':{},'facts':{},'metadata':{},'businessTags':[],'auditFields':[],'summary':{'text':'auto summary'}},'fields':{'projectName':'Automatic name','amount':54000},'seconds':.2}
    def test_worker_commit_preserves_manual_fields_original_and_notes(self):
        status,response=self.post(self.payload());self.assertEqual(status,200);c=response['contract'];self.assertEqual(c['ruleAnalysisStatus'],'done');self.assertFalse(c['needsExtraction']);self.assertEqual(c['amount'],180000);self.assertEqual(c['projectName'],'Manual project');self.assertEqual(c['rawText'],'Synthetic original');self.assertEqual(c['reviewerNotes'],'keep note');self.assertEqual(c['knowledgeProfile']['customTags'],['keep tag'])
        self.assertEqual(desktop.ANALYSIS_STATES['c']['ruleAnalysisStatus'],'done')
    def test_old_results_are_rejected_and_deleted_contract_not_recreated(self):
        for field in ['request','revision']:
            payload=self.payload();payload[field]='old';self.assertEqual(self.post(payload)[0],409)
        self.assertEqual(desktop.records('contracts')[0]['ruleAnalysisStatus'],'queued')
        desktop.delete_record('contracts','c');self.assertEqual(self.post(self.payload())[0],404)
    def test_worker_error_preserves_ocr_and_can_be_replaced_by_success(self):
        self.assertEqual(self.post({'id':'c','request':'request','revision':'revision','error':'synthetic failure'})[0],200)
        c=desktop.records('contracts')[0];self.assertEqual(c['ruleAnalysisStatus'],'error');self.assertEqual(c['rawText'],'Synthetic original')
        self.assertEqual(self.post(self.payload())[0],200)
