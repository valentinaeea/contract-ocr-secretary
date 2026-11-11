import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import excel_table as e  # noqa: E402


class ExcelTableTest(unittest.TestCase):
    def test_round_trip_keeps_text_and_escapes(self):
        rows = [{'项目名称': 'A<&>"项目"', '甲方': '甲\x01', '签约时间': '2026-10-30', '原始关键词': ['SOC2', '内部控制'], 'PIC': '张三', '合同ID': 'c1'}]
        headers, back = e.read_xlsx(e.write_xlsx(e.COLUMNS, rows))
        self.assertEqual(headers, e.COLUMNS)
        self.assertEqual(back[0]['项目名称'], 'A<&>"项目"')
        self.assertEqual(back[0]['甲方'], '甲')
        self.assertEqual(back[0]['原始关键词'], 'SOC2；内部控制')
        self.assertEqual(back[0]['FIC'], '')

    def test_reads_shared_strings_date_serials_and_title_rows(self):
        import io, zipfile
        sheet = ('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
                 '<row r="1"><c r="A1" t="s"><v>0</v></c></row>'
                 '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2" t="s"><v>2</v></c></row>'
                 '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3"><v>46325</v></c></row></sheetData></worksheet>')
        strings = ('<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                   '<si><t>说明</t></si><si><t>项目名称</t></si><si><t>签约时间</t></si>'
                   '<si><r><t>富文本</t></r><r><t>项目</t></r><rPh><t>ふりがな</t></rPh></si></sst>')
        workbook = ('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                    '<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>')
        rels = ('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>')
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as z:
            z.writestr('xl/workbook.xml', workbook)
            z.writestr('xl/_rels/workbook.xml.rels', rels)
            z.writestr('xl/sharedStrings.xml', strings)
            z.writestr('xl/worksheets/sheet1.xml', sheet)
        headers, rows = e.read_xlsx(buffer.getvalue())
        self.assertEqual(headers, ['项目名称', '签约时间'])
        self.assertEqual(rows, [{'项目名称': '富文本项目', '签约时间': '2026-10-30'}])

    def test_rejects_non_xlsx_and_missing_header(self):
        with self.assertRaises(e.ExcelError):
            e.read_xlsx(b'not a zip')
        with self.assertRaises(e.ExcelError):
            e.read_xlsx(e.write_xlsx(['别的表'], [{'别的表': 'x'}]))

    def test_merge_updates_by_id_then_fields_keeps_extra_columns_and_filled_cells(self):
        existing = [{'项目名称': 'A', '甲方': '甲', '签约时间': '2026-01-01', 'FIC': '旧', '合同ID': 'c1', '备注': '手填'},
                    {'项目名称': 'B', '甲方': '乙', '签约时间': '2026-02-02', '合同ID': ''}]
        incoming = [{'项目名称': 'A2', '合同ID': 'c1', 'FIC': ''},
                    {'项目名称': 'B', '甲方': '乙', '签约时间': '2026-02-02', '合同ID': 'c2', 'PIC': '王'},
                    {'项目名称': 'C', '合同ID': 'c3'}, {'合同ID': 'only-id'}]
        headers, rows, summary = e.merge_rows(e.COLUMNS + ['备注'], existing, incoming, 'now')
        self.assertEqual(summary, {'added': 1, 'updated': 2, 'total': 3})
        self.assertEqual(headers[-2:], ['备注', e.SYNC_COLUMN])
        self.assertEqual((rows[0]['项目名称'], rows[0]['FIC'], rows[0]['备注']), ('A2', '旧', '手填'))
        self.assertEqual((rows[1]['PIC'], rows[1]['合同ID']), ('王', 'c2'))
        self.assertEqual(rows[2]['项目名称'], 'C')

    def test_merge_into_master_folder_with_backup(self):
        with tempfile.TemporaryDirectory() as folder:
            first = e.merge_into_master(folder, [{'项目名称': 'A', '合同ID': 'c1'}])
            self.assertEqual((first['added'], first['total']), (1, 1))
            second = e.merge_into_master(folder, [{'项目名称': 'A', '合同ID': 'c1', 'EIC': '李'}, {'项目名称': 'B', '合同ID': 'c2'}])
            self.assertEqual((second['added'], second['updated'], second['total']), (1, 1, 2))
            names = sorted(p.name for p in Path(folder).iterdir())
            self.assertEqual(names, ['合同识别总表.xlsx', '合同识别总表.备份.xlsx'])
            _, rows = e.read_xlsx((Path(folder) / e.MASTER_NAME).read_bytes())
            self.assertEqual(rows[0]['EIC'], '李')
            with self.assertRaises(e.ExcelError):
                e.merge_into_master('', [])
            with self.assertRaises(e.ExcelError):
                e.merge_into_master(str(Path(folder) / 'missing'), [])

    def test_search_accepts_several_keywords(self):
        self.assertEqual(e.search_terms(' SOX，ITGC; 深圳、 财务 '), ['sox', 'itgc', '深圳', '财务'])
        with tempfile.TemporaryDirectory() as folder:
            e.merge_into_master(folder, [
                {'项目名称': '深圳SOX项目', '原始关键词': 'SOX；ITGC', '合同ID': 'a'},
                {'项目名称': '广州SOX项目', '原始关键词': 'SOX', '合同ID': 'b'},
                {'项目名称': '深圳财务转型', '原始关键词': '财务转型', '合同ID': 'c'}])
            ids = lambda result: sorted(row['row']['合同ID'] for row in result['rows'])
            self.assertEqual(ids(e.search_master(folder, '深圳，SOX', {}, None, set(), set())), ['a'])
            self.assertEqual(ids(e.search_master(folder, '深圳 SOX', {}, None, set(), set(), match_any=True)), ['a', 'b', 'c'])
            self.assertEqual(ids(e.search_master(folder, 'ITGC;财务转型', {}, None, set(), set(), match_any=True)), ['a', 'c'])

    def test_classification_columns_are_searchable_by_others(self):
        self.assertTrue({'服务领域', '具体服务', '系统'} <= set(e.COLUMNS))
        with tempfile.TemporaryDirectory() as folder:
            e.merge_into_master(folder, [{'项目名称': '某评估项目', '原始关键词': '评估', '具体服务': 'ITGC；权限管理', '系统': 'SAP', '服务领域': '内控', '合同ID': 'x'}])
            for query in ['权限管理', 'SAP', '内控 ITGC']:
                self.assertEqual([row['row']['合同ID'] for row in e.search_master(folder, query, {}, None, set(), set())['rows']], ['x'], query)

    def test_search_ignores_spaces_in_labels(self):
        with tempfile.TemporaryDirectory() as folder:
            e.merge_into_master(folder, [{'项目名称': '某鉴证项目', '原始关键词': 'SOC 2鉴证；SSAE 18；ISO 27001', '合同ID': 's'}])
            for query in ['SOC2', 'soc 2 鉴证', 'SSAE18', 'iso27001']:
                self.assertEqual([row['row']['合同ID'] for row in e.search_master(folder, query, {}, None, set(), set())['rows']], ['s'], query)


if __name__ == '__main__':
    unittest.main()
