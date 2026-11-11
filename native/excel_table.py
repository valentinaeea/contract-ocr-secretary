"""Read, write and merge the contract-list Excel table (.xlsx) with the standard library only.

The table has fixed columns (COLUMNS). Extra columns that people add by hand in a shared
master table are kept when the tool merges new rows into it.
"""
from __future__ import annotations

import datetime as _dt
import io
import os
import re
import shutil
import tempfile
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

COLUMNS = ['项目名称', '上传者ID', 'Engagement Code', 'Engagement Code Description', 'Engagement Name', '甲方', '乙方', '签约时间', '原始关键词', '服务领域', '具体服务', '系统', 'PIC', 'EIC', 'FIC', '来源文件', '合同ID']
ID_COLUMN = '合同ID'
SYNC_COLUMN = '同步时间'
SHEET_NAME = '合同列表'
MASTER_NAME = '合同识别总表.xlsx'
WIDTHS = {'项目名称': 42, '服务领域': 24, '具体服务': 36, '系统': 20, '上传者ID': 18, 'Engagement Code': 18, 'Engagement Code Description': 36, 'Engagement Name': 32, '甲方': 28, '乙方': 28, '签约时间': 13, '原始关键词': 48, 'PIC': 12, 'EIC': 12, 'FIC': 12, '来源文件': 30, '合同ID': 30, '同步时间': 20}
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL_NS = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'
_ILLEGAL = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f]')


class ExcelError(ValueError):
    """A problem the user can fix (wrong file, file in use, bad path)."""


def _column_letter(index: int) -> str:
    letters = ''
    index += 1
    while index:
        index, rest = divmod(index - 1, 26)
        letters = chr(65 + rest) + letters
    return letters


def _column_index(reference: str) -> int:
    number = 0
    for char in re.match(r'[A-Z]+', reference).group(0):
        number = number * 26 + ord(char) - 64
    return number - 1


def _clean(value) -> str:
    if value is None:
        return ''
    if isinstance(value, (list, tuple)):
        value = '；'.join(str(v) for v in value if str(v).strip())
    return _ILLEGAL.sub('', str(value)).strip()


def write_xlsx(headers: list[str], rows: list[dict]) -> bytes:
    """One sheet, bold frozen header, filter, column widths; every cell is text."""
    def cell(col, row, text, style=0):
        reference = _column_letter(col) + str(row)
        if text == '':
            return f'<c r="{reference}" s="{style}"/>' if style else ''
        return f'<c r="{reference}" t="inlineStr" s="{style}"><is><t xml:space="preserve">{escape(text)}</t></is></c>'

    lines = ['<row r="1">' + ''.join(cell(i, 1, h, 1) for i, h in enumerate(headers)) + '</row>']
    for r, row in enumerate(rows, start=2):
        lines.append(f'<row r="{r}">' + ''.join(cell(i, r, _clean(row.get(h)), 2) for i, h in enumerate(headers)) + '</row>')
    last_col, last_row = _column_letter(max(len(headers) - 1, 0)), max(len(rows) + 1, 1)
    last = f'{last_col}{last_row}'
    cols = ''.join(f'<col min="{i+1}" max="{i+1}" width="{WIDTHS.get(h, 16)}" customWidth="1"/>' for i, h in enumerate(headers))
    sheet = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             f'<dimension ref="A1:{last}"/>'
             '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
             f'<cols>{cols}</cols><sheetData>{"".join(lines)}</sheetData>'
             f'<autoFilter ref="A1:{last}"/></worksheet>')
    styles = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
              '<fonts count="2"><font><sz val="11"/><name val="等线"/></font><font><b/><sz val="11"/><name val="等线"/></font></fonts>'
              '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
              '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF9"/><bgColor indexed="64"/></patternFill></fill></fills>'
              '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
              '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
              '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
              '<xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>'
              '<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>'
              '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
    files = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="{SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'{SHEET_NAME}\'!$A$1:${last_col}${last_row}</definedName></definedNames></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        'xl/styles.xml': styles,
        'xl/worksheets/sheet1.xml': sheet,
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, text in files.items():
            archive.writestr(name, text.encode('utf-8'))
    return buffer.getvalue()


def _excel_date(value: str) -> str:
    try:
        serial = float(value)
    except ValueError:
        return value
    if 20000 < serial < 80000:  # 1954..2119: a date Excel stored as a serial number
        return (_dt.date(1899, 12, 30) + _dt.timedelta(days=int(serial))).isoformat()
    return value


def read_xlsx(data: bytes) -> tuple[list[str], list[dict]]:
    """Return (headers, rows) of the first sheet; the header row is the first row containing 项目名称."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ExcelError('不是有效的 Excel 文件（请使用 .xlsx 格式；.xls 或 .csv 请先在 Excel 里另存为 .xlsx）')
    names = set(archive.namelist())
    if 'xl/workbook.xml' not in names:
        raise ExcelError('不是有效的 Excel 文件（缺少工作簿）')
    shared = []
    if 'xl/sharedStrings.xml' in names:
        for item in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('m:si', NS):
            parts = [item.find('m:t', NS)] + [r.find('m:t', NS) for r in item.findall('m:r', NS)]
            shared.append(''.join(t.text or '' for t in parts if t is not None))  # skips phonetic rPh runs
    workbook = ET.fromstring(archive.read('xl/workbook.xml'))
    first = workbook.find('m:sheets/m:sheet', NS)
    target = 'xl/worksheets/sheet1.xml'
    if first is not None and 'xl/_rels/workbook.xml.rels' in names:
        rels = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
        for rel in rels:
            if rel.get('Id') == first.get(REL_NS):
                path = rel.get('Target').lstrip('/')
                target = path if path.startswith('xl/') else 'xl/' + path
    if target not in names:
        raise ExcelError('Excel 文件里找不到工作表')
    grid = []
    for row in ET.fromstring(archive.read(target)).iter('{%s}row' % NS['m']):
        values = {}
        for c in row.findall('m:c', NS):
            kind, ref = c.get('t'), c.get('r')
            if kind == 'inlineStr':
                text = ''.join(t.text or '' for t in c.iter('{%s}t' % NS['m']))
            else:
                v = c.find('m:v', NS)
                text = '' if v is None or v.text is None else v.text
                if kind == 's' and text:
                    text = shared[int(text)] if int(text) < len(shared) else ''
                elif kind == 'b':
                    text = 'TRUE' if text == '1' else 'FALSE'
                elif kind is None and re.fullmatch(r'-?\d+\.0+', text):
                    text = text.split('.')[0]
            values[_column_index(ref) if ref else len(values)] = text.strip()
        grid.append(values)
    header_at = next((i for i, row in enumerate(grid) if '项目名称' in row.values()), None)
    if header_at is None:
        raise ExcelError('表格里找不到“项目名称”表头，请使用本工具导出的合同列表格式')
    header_cells = grid[header_at]
    headers = [header_cells[i] for i in sorted(header_cells) if header_cells[i]]
    positions = {header_cells[i]: i for i in sorted(header_cells) if header_cells[i]}
    rows = []
    for values in grid[header_at + 1:]:
        row = {h: values.get(positions[h], '') for h in headers}
        if not any(row.values()):
            continue
        if row.get('签约时间'):
            row['签约时间'] = _excel_date(row['签约时间'])
        rows.append(row)
    return headers, rows


def row_key(row: dict) -> str:
    if row.get(ID_COLUMN):
        return 'id:' + row[ID_COLUMN]
    return 'fields:' + '|'.join(row.get(h, '').strip().lower() for h in ['项目名称', '甲方', '乙方', '签约时间'])


def merge_rows(headers: list[str], existing: list[dict], incoming: list[dict], stamp: str = '') -> tuple[list[str], list[dict], dict]:
    """Update rows with the same 合同ID (or same name/parties/date), append the rest.

    Hand-added columns in the existing table are kept; a blank incoming cell does not erase a filled one.
    """
    merged_headers = list(COLUMNS) + [h for h in headers if h not in COLUMNS and h != SYNC_COLUMN] + [SYNC_COLUMN]
    rows = [dict(r) for r in existing]
    index = {row_key(r): i for i, r in enumerate(rows)}
    added = updated = 0
    for row in incoming:
        clean = {h: _clean(row.get(h)) for h in COLUMNS}
        if not any(clean[h] for h in COLUMNS if h != ID_COLUMN):
            continue
        key = row_key(clean)
        if key not in index and clean.get(ID_COLUMN):
            key = row_key({**clean, ID_COLUMN: ''})
        if key in index:
            target = rows[index[key]]
            for h, value in clean.items():
                if value:
                    target[h] = value
            if stamp:
                target[SYNC_COLUMN] = stamp
            updated += 1
        else:
            if stamp:
                clean[SYNC_COLUMN] = stamp
            rows.append(clean)
            index[row_key(clean)] = len(rows) - 1
            added += 1
    return merged_headers, rows, {'added': added, 'updated': updated, 'total': len(rows)}


def master_path(configured: str) -> Path:
    text = (configured or '').strip().strip('"')
    if not text:
        raise ExcelError('请先在「设置」里填写云盘同步文件夹或总表文件路径')
    path = Path(os.path.expandvars(os.path.expanduser(text)))
    if path.suffix.lower() == '.xlsx':
        if not path.parent.is_dir():
            if text.startswith('\\\\'):
                raise ExcelError('无法访问内网共享文件夹：' + str(path.parent) + '。请先在文件资源管理器中打开并用域账号登录后重试')
            raise ExcelError('找不到总表所在的文件夹：' + str(path.parent))
        return path
    if path.is_dir():
        return path / MASTER_NAME
    if text.startswith('\\\\'):
        raise ExcelError('无法访问内网共享文件夹：' + text + '。请先在文件资源管理器地址栏打开该路径并用域账号登录，确认已连接公司内网后重试')
    raise ExcelError('路径需要是已存在的文件夹，或以 .xlsx 结尾的文件：' + str(path))


TERM_SEPARATORS = re.compile(r'[\s,，;；、]+')


def search_terms(query: str) -> list[str]:
    """Several keywords separated by spaces, commas, semicolons or 、."""
    return [term for term in TERM_SEPARATORS.split(unicodedata.normalize('NFKC', query or '').casefold()) if term]


def search_master(configured: str, query: str, people: dict, eligible_ids: set | None,
                  direct_ids: set, related_ids: set, match_any: bool = False) -> dict:
    def normalize(text):
        # 与本地检索一致：忽略空格、下划线、连字符和斜杠，「SOC2」也能命中「SOC 2」
        return re.sub(r'[\s_\-/]+', '', unicodedata.normalize('NFKC', str(text or '')).casefold())

    terms = [normalize(term) for term in search_terms(query)]
    terms = [term for term in terms if term]
    combine = any if match_any else all
    if not terms and not any(people.values()) and eligible_ids is None:
        return {'rows': [], 'total': 0}
    path = master_path(configured)
    try:
        _, rows = read_xlsx(path.read_bytes())
    except FileNotFoundError:
        raise ExcelError('当前路径还没有云盘总表，请先合并合同或检查同步状态')
    except OSError:
        raise ExcelError('无法读取云盘总表，请检查文件权限和同步状态')

    matches = []
    total = 0
    for row in rows:
        public_row = {column: row.get(column, '') for column in COLUMNS}
        identifier = public_row[ID_COLUMN]
        if eligible_ids is not None and identifier not in eligible_ids:
            continue
        if any(normalize(people.get(role.lower(), '')) not in normalize(public_row[role])
               for role in ('PIC', 'EIC')):
            continue
        person = normalize(people.get('person', ''))
        if person and not any(person in normalize(public_row[role]) for role in ('PIC', 'EIC', 'FIC')):
            continue
        fields = [normalize(value) for value in public_row.values()]
        direct = identifier in direct_ids or (bool(terms) and combine(any(term in field for field in fields) for term in terms))
        if direct or identifier in related_ids:
            total += 1
            if len(matches) < 100:
                matches.append({'row': public_row, 'kind': 'direct' if direct else 'related'})
    return {'rows': matches, 'total': total}


def merge_into_master(configured: str, incoming: list[dict]) -> dict:
    path = master_path(configured)
    headers, existing = [], []
    if path.exists():
        try:
            headers, existing = read_xlsx(path.read_bytes())
        except PermissionError:
            raise ExcelError('总表正被占用（可能在 Excel 中打开），请关闭后重试')
        backup = path.with_name(path.stem + '.备份.xlsx')
        try:
            shutil.copy2(path, backup)
        except OSError:
            raise ExcelError('无法备份总表，请检查文件夹权限或关闭正在打开的总表')
    stamp = _dt.datetime.now().strftime('%Y-%m-%d %H:%M')
    headers, rows, summary = merge_rows(headers, existing, incoming, stamp)
    data = write_xlsx(headers, rows)
    handle, temporary = tempfile.mkstemp(prefix='.合同总表-', suffix='.xlsx', dir=path.parent)
    try:
        with os.fdopen(handle, 'wb') as file:
            file.write(data)
        os.replace(temporary, path)
    except PermissionError:
        raise ExcelError('总表正被占用（可能在 Excel 中打开），请关闭后重试')
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {**summary, 'path': str(path)}
