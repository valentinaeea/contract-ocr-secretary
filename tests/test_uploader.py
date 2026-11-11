"""上传者ID (no login): each computer records its uploader name; it is stamped by the local service and written to the cloud master. Synthetic data only."""
import http.server
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.request
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import desktop
import excel_table


class UploaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.previous = desktop.DATA_ROOT, desktop.DB_PATH
        desktop.DATA_ROOT = self.root / 'data'; desktop.DB_PATH = desktop.DATA_ROOT / 'state.sqlite3'
        desktop.initialize_store()
        self.default_cloud=desktop.DEFAULT_CLOUD_PATH;desktop.DEFAULT_CLOUD_PATH=''
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), desktop.Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self):
        self.server.shutdown(); self.server.server_close()
        desktop.DATA_ROOT, desktop.DB_PATH = self.previous; desktop.DEFAULT_CLOUD_PATH=self.default_cloud; self.tmp.cleanup()

    def post(self, path, payload):
        headers = {'Origin': self.origin, 'X-OCR-Token': desktop.TOKEN, 'Content-Type': 'application/json'}
        with self.opener.open(urllib.request.Request(self.origin + path, data=json.dumps(payload).encode(), headers=headers)) as response:
            body = response.read()
            return json.loads(body) if response.headers.get('Content-Type', '').startswith('application/json') else body

    def get(self, path):
        with self.opener.open(self.origin + path) as response:return json.loads(response.read())

    def test_default_is_computer_account_and_setting_overrides_it(self):
        with patch.dict('os.environ', {'USERNAME': 'win-user'}):
            self.assertEqual(desktop.uploader_name(), 'win-user')
            self.assertEqual(self.get('/api/config')['uploaderDefault'], 'win-user')
            self.post('/api/config', {'key': 'uploader', 'value': {'name': '  同事甲  '}})
            self.assertEqual(desktop.uploader_name(), '同事甲')
            self.post('/api/config', {'key': 'uploader', 'value': {'name': ''}})
            self.assertEqual(desktop.uploader_name(), 'win-user')

    def test_uploader_is_stamped_once_and_cannot_be_forged(self):
        self.post('/api/config', {'key': 'uploader', 'value': {'name': '同事甲'}})
        self.post('/api/contracts', {'action': 'add', 'contract': {'id': 'c1', 'projectName': '合同', 'uploadedByName': 'FORGED'}})
        saved = desktop.get_record('contracts', 'c1')
        self.assertEqual(saved['uploadedByName'], '同事甲'); self.assertIn('uploadedAt', saved)
        # Renaming later does not rewrite who uploaded existing contracts; edits cannot change it either.
        self.post('/api/config', {'key': 'uploader', 'value': {'name': '改名后'}})
        self.post('/api/contracts', {'action': 'update', 'contract': {**saved, 'projectName': '改名', 'uploadedByName': 'FORGED'}})
        self.assertEqual(desktop.get_record('contracts', 'c1')['uploadedByName'], '同事甲')
        self.assertEqual(desktop.merge_recovered(saved, {'id': 'c1', 'rawText': 'new'})['uploadedByName'], '同事甲')

    def test_secretary_cloud_path_is_fixed_and_api_cannot_override_it(self):
        desktop.DEFAULT_CLOUD_PATH = str(self.root / 'fixed')
        desktop.put('config', 'cloudExcel', {'key': 'cloudExcel', 'value': {'path': 'OLD'}})
        self.assertEqual(desktop.cloud_path(), str(self.root / 'fixed'))
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.post('/api/config', {'key': 'cloudExcel', 'value': {'path': 'FORGED'}})
        self.assertEqual(error.exception.code, 403)
        self.assertEqual(desktop.cloud_path(), str(self.root / 'fixed'))

    def test_cloud_master_has_server_filled_uploader_column(self):
        self.post('/api/config', {'key': 'uploader', 'value': {'name': '同事甲'}})
        self.post('/api/contracts', {'action': 'add', 'contract': {'id': 'c1', 'projectName': '合同一'}})
        cloud = self.root / 'cloud'; cloud.mkdir()
        desktop.DEFAULT_CLOUD_PATH = str(cloud)
        row = {'项目名称': '合同一', '上传者ID': '冒充的人', '合同ID': 'c1'}
        result = self.post('/api/excel/cloud-merge', {'rows': [row]})
        self.assertEqual(result['added'], 1)
        headers, rows = excel_table.read_xlsx((cloud / excel_table.MASTER_NAME).read_bytes())
        self.assertEqual(headers[:2], ['项目名称', '上传者ID'])
        self.assertEqual(rows[0]['上传者ID'], '同事甲')
        exported = self.post('/api/excel/export', {'rows': [row]})
        self.assertEqual(excel_table.read_xlsx(exported)[1][0]['上传者ID'], '同事甲')
        # Other people's rows in the shared master keep their own 上传者ID and are searchable here.
        excel_table.merge_into_master(str(cloud), [{'项目名称': '他人合同', '上传者ID': '同事乙', '合同ID': 'remote-1'}])
        found = self.post('/api/excel/cloud-search', {'query': '他人合同', 'people': {}, 'directIds': [], 'relatedIds': []})
        self.assertEqual(found['rows'][0]['row']['上传者ID'], '同事乙')


class DefaultCloudPathTests(unittest.TestCase):
    def test_intranet_share_is_the_default_and_unreachable_share_explains_login(self):
        self.assertTrue(desktop.cloud_path())
        try:
            excel_table.master_path(r'\\unreachable.invalid\share\合同')
        except excel_table.ExcelError as error:
            self.assertIn('登录', str(error))
        else:
            self.fail('unreachable share must raise')


if __name__ == '__main__':
    unittest.main()
