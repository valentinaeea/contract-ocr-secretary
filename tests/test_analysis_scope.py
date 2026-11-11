import sys,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
from analysis_scope import resolve_scope,classify_scoped
class AnalysisScopeTests(unittest.TestCase):
    def test_scope_and_semantic_input(self):
        raw='正文 服务内容：数据迁移。\n附录一 工作说明书\n服务内容：ITGC。\n附录二\n服务内容：流程优化。'
        scope=resolve_scope(raw,'ey-template');self.assertEqual(scope['status'],'found');self.assertNotIn('数据迁移',scope['text']);self.assertNotIn('流程优化',scope['text']);self.assertEqual(raw[scope['start']:scope['end']],scope['text'])
        with patch('semantic.classify',return_value={'semanticTags':[]}) as classify:
            result=classify_scoped(raw,'ey-template');classify.assert_called_once_with(scope['text']);self.assertEqual(result['uploadCategory'],'ey-template')
    def test_english_appendix_boundary(self):
        scope=resolve_scope('Appendix I Statement of Work\nScope of services: ITGC.\nAppendix II Other Terms\nScope of services: data migration.','ey-template')
        self.assertNotIn('data migration',scope['text'])
    def test_general_terms_are_blanked_in_place_and_match_browser(self):
        import json,subprocess
        cases=json.loads((Path(__file__).parent/'general_terms_cases.json').read_text(encoding='utf-8'))
        for raw,category in cases:
            scope=resolve_scope(raw,category)
            self.assertNotIn('付款',scope['text']);self.assertNotIn('Fees',scope['text']);self.assertNotIn('保密',scope['text'])
            self.assertIn('ITGC',scope['text'])
            if scope['status'] in ('full','found'):self.assertEqual(len(scope['text']),scope['end']-scope['start'])
        self.assertNotIn('已跳过',resolve_scope(cases[-1][0])['label'])
        self.assertIn('交付物',resolve_scope(cases[0][0])['text'])
        self.assertIn('第六条 交付',resolve_scope(cases[1][0])['text'])
        self.assertIn('3. 交付',resolve_scope(cases[2][0])['text'])
        self.assertIn('交付成果',resolve_scope(cases[3][0])['text'])
        script="const fs=require('fs'),vm=require('vm'),c=vm.createContext({});vm.runInContext(fs.readFileSync('js/contract-scope.js','utf8'),c);const C=vm.runInContext('ContractScope',c);const cases=JSON.parse(fs.readFileSync('tests/general_terms_cases.json','utf8'));process.stdout.write(Buffer.from(JSON.stringify(cases.map(([raw,cat])=>{const s=C.resolve({rawText:raw,uploadCategory:cat});return [s.text,s.label]}))))"
        try:out=subprocess.run(['node','-e',script],cwd=Path(__file__).resolve().parents[1],capture_output=True,check=True).stdout
        except FileNotFoundError:self.skipTest('node not installed')
        self.assertEqual(json.loads(out.decode('utf-8')),[[resolve_scope(raw,cat)['text'],resolve_scope(raw,cat)['label']] for raw,cat in cases])
    def test_other_legacy_and_missing(self):
        raw='服务内容：数据迁移。'
        self.assertEqual(resolve_scope(raw)['text'],raw)
        with patch('semantic.classify') as classify:
            self.assertEqual(classify_scoped(raw,'ey-template')['semanticTags'],[]);classify.assert_not_called()
    def test_heading_variants_and_toc(self):
        for title in ['附 录 一\n工 作 说 明 书','Appendix I Statement of Work','Annex 1\nSOW','附件1：工作说明书']:
            scope=resolve_scope('正文\n'+title+'\n服务内容：ITGC。\n附录二\n数据迁移。','ey-template');self.assertEqual(scope['status'],'found');self.assertNotIn('数据迁移',scope['text'])
        self.assertEqual(resolve_scope('附录一 保密协议\n附录二 工作说明书\n数据迁移。','ey-template')['status'],'missing')
