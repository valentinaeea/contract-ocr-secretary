"""Select the work-statement appendix for EY uploads; keep full OCR unchanged."""
import re
import unicodedata

# Mirrors js/contract-scope.js: 一般条款／通用条款／商务条款 sections are blanked (same length, newlines kept) before analysis.
GENERAL_HEADING=re.compile('^(?:(?:附录|附件|appendix|annex|schedule|exhibit)[一二三四五六七八九十百\\da-z]{0,4}|第[一二三四五六七八九十百\\d]{1,3}(?:部分|章|篇|节|条)|part[ivx\\d]{1,4}|[一二三四五六七八九十\\d]{1,3})?(?:(?:合同|协议|业务约定书|业务约定|服务)?(?:一般商务|通用商务|一般业务|一般合同|通用合同|标准合同|一般|通用|标准|商务|商业|商用)(?:条款|条件)(?:和条件|及条件|与条件)?|(?:general|standard)(?:business|commercial)?(?:terms|conditions)(?:andconditions|ofbusiness)?|termsofbusiness|commercialterms|termsandconditions)(?:续)?$',re.I)
SECTION_END=re.compile('^(?:(?:附录|附件|appendix|annex|schedule|exhibit)[一二三四五六七八九十百\\da-z]{1,4}|第[一二三四五六七八九十百\\d]{1,3}(?:部分|篇)|part[ivx\\d]{1,4})|^(?:[一二三四五六七八九十\\d]{1,3})?(?:工作说明书|服务说明书|statementofwork|专用条款|特别条款|特殊条款|专项条款|签字页|签署页)|^(?:[一二三四五六七八九十\\d]{1,3})?(?:技术条款|技术要求|服务内容|服务范围|工作内容|工作范围|项目内容|项目范围|项目需求|交付物|交付成果)$',re.I)
NUMBERING=[re.compile(r) for r in ['^\\s*[一二三四五六七八九十百]+\\s*[、.．]', '^\\s*第\\s*[一二三四五六七八九十百\\d]+\\s*条', '^\\s*第\\s*[一二三四五六七八九十百\\d]+\\s*章', '^\\s*\\d+\\s*[、.．](?!\\s*\\d)', '^\\s*[（(]\\s*[一二三四五六七八九十]+\\s*[)）]']]

def _heading(line):
    return re.sub(r'[\s：:、.．（）()《》]','',unicodedata.normalize('NFKC',line)).lower()

def general_sections(text):
    rows=[];offset=0
    for line in text.split('\n'):
        rows.append(dict(raw=line,start=offset,h=_heading(line)));offset+=len(line)+1
    spans=[];i=0
    while i<len(rows):
        row=rows[i]
        if row['h'] and len(row['h'])<=40 and GENERAL_HEADING.search(row['h']) and not re.search(r'\.{2,}|…|[·•]{2,}',row['raw']):
            level=next((r for r in NUMBERING if r.search(row['raw'])),None)
            end=len(text)
            for other in rows[i+1:]:
                h=other['h']
                if not h or GENERAL_HEADING.search(h):continue
                if (level and level.search(other['raw'])) or (len(h)<=40 and SECTION_END.search(h)):
                    end=other['start'];break
            spans.append((row['start'],end))
            while i+1<len(rows) and rows[i+1]['start']<end:i+=1
        i+=1
    return spans

def _skip_general(text,scope):
    spans=[(max(a,scope['start']),min(b,scope['end'])) for a,b in general_sections(text)]
    spans=[(a,b) for a,b in spans if b>a]
    if not spans or not scope['text']:return scope
    out=scope['text']
    for a,b in spans:
        a-=scope['start'];b-=scope['start']
        out=out[:a]+re.sub(r'[^\n]',' ',out[a:b])+out[b:]
    return dict(scope,text=out,skippedGeneral=len(spans),label=scope['label']+' · 已跳过一般条款')

def resolve_scope(text, category='other'):
    text=str(text or '')
    return _skip_general(text,_locate(text,category))

def _locate(text, category='other'):
    if category!='ey-template':return dict(status='full',start=0,end=len(text),text=text,label='全文分析')
    rows=[];offset=0
    for line in text.split('\n'):
        heading=re.sub(r'[\s：:、.．（）()《》]','',unicodedata.normalize('NFKC',line)).lower()
        rows.append(dict(raw=line,start=offset,h=heading));offset+=len(line)+1
    first=re.compile(r'^(?:附录|附件)(?:一|1|i)(?![\divx一二三四五六七八九十百])|^(?:appendix|annex|schedule)(?:1|i)(?![\divx])',re.I)
    following=re.compile(r'^(?:附录|附件)(?:[二三四五六七八九十百]|[2-9]|1\d)|^(?:appendix|annex|schedule)(?:[2-9]|1\d|viii|vii|vi|iv|iii|ii|ix|v|x)',re.I)
    empty=None
    for i,row in enumerate(rows):
        if not first.search(row['h']) or len(row['h'])>150:continue
        if re.search(r'\.{2,}|…|[·•]{2,}',row['raw']) or re.search(r'(?:工作说明书|服务说明书|Statement\s*of\s*Work|SOW)\s*\d+\s*页?\s*$',row['raw'],re.I):continue
        tail=first.sub('',row['h'])
        if tail and not re.search(r'工作|说明|服务|statement|sow',tail,re.I):continue
        title=row['h']
        for following_row in rows[i+1:i+3]:
            if re.search(r'^(?:附录|附件|appendix|annex|schedule)',following_row['h'],re.I):break
            title+=following_row['h']
        if not re.search(r'工作说明书|服务说明书|statementofwork|sow',title,re.I):continue
        if re.search(r'详见|参见|请见|见附|目录',row['h']):continue
        end=next((r['start'] for r in rows[i+1:] if len(r['h'])<150 and following.search(r['h'])),len(text))
        selected=text[row['start']:end]
        body=re.sub(r'[\s：:、.．（）()《》]','',unicodedata.normalize('NFKC',selected[len(row['raw']):])).lower()
        body=re.sub(r'工作说明书|服务说明书|statementofwork|sow','',body)
        if not body or re.fullmatch(r'[\d第页ofpage/.-]*',body,re.I):
            empty=dict(status='empty',start=row['start'],end=end,text='',label='工作说明书未识别到正文，未生成自动Tag');continue
        return dict(status='found',start=row['start'],end=end,text=selected,label='仅分析附录一／工作说明书')
    return empty or dict(status='missing',start=0,end=0,text='',label='未定位附录一／工作说明书，未生成自动Tag')

def classify_scoped(text, category='other'):
    from semantic import classify
    scope=resolve_scope(text,category)
    result=classify(scope['text']) if scope['text'].strip() else {'semanticTags':[]}
    return {**result,'uploadCategory':category,'analysisScope':{k:v for k,v in scope.items() if k!='text'}}
