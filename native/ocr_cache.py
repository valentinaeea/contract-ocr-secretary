"""Local content-addressed recognition cache. Never caches business/manual analysis."""
import hashlib,json,time,uuid
from pathlib import Path
PIPELINE='ocr-layout-2.14.0'
FIELDS={'rawText','pageCount','ocrUsed','reviewNotes','engine','workerPid','seconds','failedPages','resumedPages','peakWorkerMemoryMB','pageAudit','layoutPages','ocrModel'}
def cache_key(data,mode,filename):
    kind='pdf' if filename.lower().endswith('.pdf') else 'image'
    from engine import model_tag
    models=model_tag(mode)+'/'+model_tag('fine')  # results from a different model set are never reused
    return hashlib.sha256(data).hexdigest()+'-'+hashlib.sha256((PIPELINE+':'+mode+':'+kind+':'+models).encode()).hexdigest()[:16]
def load(root,key):
    try:
        path=Path(root)/(key+'.json');record=json.loads(path.read_text(encoding='utf-8'))
        if record.get('pipeline')!=PIPELINE:return None
        value=record['result']
        if not isinstance(value.get('rawText'),str) or not isinstance(value.get('layoutPages'),list) or not isinstance(value.get('pageAudit'),list):return None
        if value.get('failedPages') or value.get('pageCount')!=len(value['pageAudit']):return None
        path.touch()
        return {**value,'ocrCacheHit':True,'originalRecognitionSeconds':value.get('seconds',0),'seconds':0,'resumedPages':value.get('pageCount',0)}
    except (OSError,ValueError,KeyError,TypeError):return None
def save(root,key,result):
    if result.get('failedPages') or not isinstance(result.get('rawText'),str) or not result.get('layoutPages') or len(result.get('pageAudit',[]))!=result.get('pageCount'):return
    root=Path(root);root.mkdir(parents=True,exist_ok=True)
    path=root/(key+'.json');temporary=root/(key+'.'+uuid.uuid4().hex+'.tmp')
    try:
        temporary.write_text(json.dumps({'pipeline':PIPELINE,'result':{k:v for k,v in result.items() if k in FIELDS}},ensure_ascii=False),encoding='utf-8');temporary.replace(path)
        files=sorted(root.glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True);size=0
        for index,item in enumerate(files):
            size+=item.stat().st_size
            if index>=128 or size>512*1024**2:item.unlink(missing_ok=True)
    finally:temporary.unlink(missing_ok=True)
