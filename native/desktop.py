"""Local-only OCR service and launcher. Never sends documents to external services."""
from __future__ import annotations
import concurrent.futures
import http.server
import io
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import secrets
import signal
import sqlite3
import threading
import uuid
import sys
import time
import urllib.parse
import webbrowser

from engine import initialize_engine, recognize_image

VERSION = '2.15.0'
HOST = '127.0.0.1'
PORT = int(os.environ.get('CONTRACT_OCR_PORT', '18765'))
MAX_BYTES = 32 * 1024 * 1024
TOKEN = secrets.token_urlsafe(32)
ENGINE = None
DATA_ROOT = Path(os.environ.get('CONTRACT_OCR_DATA_DIR', str((Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent.parent) / 'ContractOCR_Data')))
DB_PATH = DATA_ROOT / 'state.sqlite3'
JOB_LOCK = threading.RLock()
JOB_FUTURES = {}
JOB_SAVE_ERRORS = {}
ANALYSIS_FUTURES = {}
ANALYSIS_STATES = {}
DB_LOCK = threading.RLock()
EXCEL_LOCK = threading.Lock()


def record_path(table, key):
    if table not in ['contracts', 'jobs', 'config']:
        raise ValueError('Invalid store')
    digest = hashlib.sha256(str(key).encode('utf-8')).hexdigest()
    return DATA_ROOT / table / (digest + '.json')


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def storage_usage():
    total = 0
    for path in DATA_ROOT.rglob('*'):
        try:
            if path.is_file(): total += path.stat().st_size
        except FileNotFoundError:
            pass
    return total


def records(table):
    with DB_LOCK:
        return [json.loads(path.read_text(encoding='utf-8')) for path in (DATA_ROOT / table).glob('*.json')]


def get_record(table, key):
    """Read one record by key. Lookups must not parse the whole contract library."""
    with DB_LOCK:
        try:
            value = json.loads(record_path(table, key).read_text(encoding='utf-8'))
        except FileNotFoundError:
            return None
        return value if isinstance(value, dict) and value.get('key' if table == 'config' else 'id') == key else None


def raw_records(table):
    # Serve listings without json.loads + json.dumps of every (large) contract.
    with DB_LOCK:
        parts = []
        for path in (DATA_ROOT / table).glob('*.json'):
            try:
                parts.append(path.read_bytes())
            except FileNotFoundError:
                pass
        return b'[' + b','.join(parts) + b']'


def put(table, key, value):
    with DB_LOCK:
        write_json(record_path(table, key), value)


def job_records():
    return list({**{job['id']:job for job in records('jobs')},**JOB_SAVE_ERRORS}.values())


def get_job(identifier):
    return JOB_SAVE_ERRORS.get(identifier) or get_record('jobs', identifier)


OCR_RESULT_FIELDS = ['id','rawText','pageCount','ocrUsed','reviewNotes','engine','workerPid','workerPids','seconds','failedPages','resumedPages','peakWorkerMemoryMB','pageAudit','layoutPages','sourceAvailable','sourceNote','ocrCacheHit','originalRecognitionSeconds','semanticTags','analysisStatus','ocrModel','workerPids','ocrThreads','ocrWorkers','stageSeconds']


def job_result(job):
    """OCR results live once, in the contract record; job files stay small for fast polling."""
    if 'result' in job:
        return job['result']
    contract = get_record('contracts', job['id']) or {}
    result = {key: contract[key] for key in OCR_RESULT_FIELDS if key in contract}
    if contract.get('recoveredOCRText'):
        result['rawText'] = contract['recoveredOCRText']
    return result


def source_path(identifier):
    return DATA_ROOT / 'sources' / (hashlib.sha256(str(identifier).encode('utf-8')).hexdigest() + '.bin')


def save_source(identifier, data):
    destination = source_path(identifier)
    temporary = destination.with_suffix('.tmp')
    with temporary.open('wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(destination)


def delete_record(table, key):
    with DB_LOCK:
        record_path(table, key).unlink(missing_ok=True)


def clear_records(table):
    with DB_LOCK:
        for path in (DATA_ROOT / table).glob('*.json'): path.unlink()


def cleanup_queue_file(path):
    # A polling reader or Windows scanner may briefly deny deletion.
    for attempt in range(5):
        try:
            Path(path).unlink(missing_ok=True)
            return True
        except OSError:
            if attempt < 4:
                time.sleep(.02 * (attempt + 1))
    return False  # Retried when the application next initializes its queue.


def initialize_store():
    for folder in ['queue', 'contracts', 'jobs', 'config', 'sources', 'checkpoints','ocr_cache']:
        (DATA_ROOT / folder).mkdir(parents=True, exist_ok=True)
    marker = DATA_ROOT / 'storage_version.json'
    # One-time migration preserves 2.6.1 data and keeps the old DB as a backup.
    if not marker.exists():
        if DB_PATH.exists():
            connection = sqlite3.connect(DB_PATH, timeout=15)
            try:
                for table in ['contracts', 'jobs', 'config']:
                    try:
                        rows = connection.execute(f'SELECT * FROM {table}').fetchall()
                    except sqlite3.OperationalError:
                        continue
                    for key, payload in rows:
                        value = json.loads(payload)
                        put(table, key, {'key': key, 'value': value} if table == 'config' else value)
            finally:
                connection.close()
        write_json(marker, {'version': 2, 'format': 'atomic JSON files'})
    for job in job_records():
        if not isinstance(job, dict) or 'id' not in job:
            continue
        if 'status' not in job:
            job.update(status='error', error='旧任务记录不完整，请重新提交文件')
            put('jobs', job['id'], job)
        if job.get('status') in ['queued','running','cancelling']:
            if job.get('cancelRequested') or job.get('status')=='cancelling':
                job.update(status='cancelled',retryAvailable=False)
            elif (DATA_ROOT/'queue'/(job['id']+'.input')).exists():
                job.update(status='interrupted',retryAvailable=True,error='程序中断，重新启动后从已完成页继续')
            else:job.update(status='error',retryAvailable=False,error='原文件未保留，请重新上传')
            put('jobs',job['id'],job)
        elif 'result' in job and record_path('contracts',job['id']).exists():
            # Before 2.13.2 every finished job kept a second full copy of the OCR result,
            # which progress polling re-read for every job. The contract keeps the result.
            job.pop('result',None)
            put('jobs',job['id'],job)
    keep={job['id']+'.input' for job in job_records() if job.get('retryAvailable') or job.get('status')=='interrupted'}
    for path in (DATA_ROOT/'queue').glob('*'):
        if path.name not in keep:cleanup_queue_file(path)


# Secretary v1: edit native/secretary_config.py for the built-in destination.
from secretary_config import CLOUD_EXCEL_PATH
DEFAULT_CLOUD_PATH = os.environ.get('CONTRACT_OCR_CLOUD_DEFAULT', CLOUD_EXCEL_PATH)


def cloud_path():
    # Ignore old browser configuration in the secretary edition.
    return DEFAULT_CLOUD_PATH


def default_uploader():
    """This computer's Windows / system account name, used until 系统设置 sets a 上传者ID."""
    import getpass
    for value in (os.environ.get('USERNAME'), os.environ.get('USER')):
        if value and value.strip():return value.strip()
    try:return getpass.getuser() or '本机用户'
    except Exception:return '本机用户'


def uploader_name():
    """上传者ID recorded on contracts uploaded from this computer (no login: one uploader per workstation)."""
    configured=((get_record('config','uploader') or {}).get('value') or {}).get('name','')
    return str(configured).strip()[:60] or default_uploader()


UPLOAD_FIELDS=('uploadedByName','uploadedAt')


def stamp_uploader(contract, existing=None):
    """Keep the first recorded uploader; new records get this computer's uploader. Client values are ignored."""
    for field in UPLOAD_FIELDS:contract.pop(field,None)
    if existing and existing.get('uploadedByName'):
        for field in UPLOAD_FIELDS:
            if field in existing:contract[field]=existing[field]
    elif not existing:
        contract['uploadedByName']=uploader_name();contract['uploadedAt']=int(time.time()*1000)
    return contract


def merge_recovered(existing, incoming):
    merged={**existing,**incoming}
    for key in ['uploadedByName','uploadedAt','reviewerNotes','serviceSummary','businessReview','businessReviewEditedAt','pageChecks','criticalChecks','criticalReviewHistory','auditPurpose','auditPurposeEditedAt','originalRawText','editedLayoutPages','editedLayoutFingerprint','editedLayoutMode','rawTextEditedAt','manualFieldsEditedAt','manualEditHistory','amountManuallyEdited','knowledgeProfile']:
        if key in existing:merged[key]=existing[key]
    if existing.get('rawTextEditedAt'):
        merged['recoveredOCRText']=incoming.get('rawText','')
        merged['rawText']=existing['rawText']
        for key in ['semanticTags','semanticModel','semanticNote']:
            if key in existing:merged[key]=existing[key]
    if existing.get('manualFieldsEditedAt'):
        for key in ['projectName','partyA','partyB','amount','signDate','content','deliverables']:
            if key in existing:merged[key]=existing[key]
        merged['needsExtraction']=False
    return merged



ANALYSIS_FIELDS = ['managedBusinessAnalysis','ruleAnalysisStatus','ruleAnalysisError','ruleAnalysisSeconds','businessSnapshot','analysisStatus','analysisRequest','analysisFingerprint','analysisStartedAt','analysisCompletedAt','analysisSeconds','analysisError','semanticTags','semanticModel','semanticNote','analysisScope']
def analysis_state(contract):
    return {k:contract.get(k) for k in ['id','analysisStatus','analysisRequest','analysisError','ruleAnalysisStatus','ruleAnalysisError','ruleAnalysisSeconds']}

def analysis_fingerprint(contract):
    return hashlib.sha256(('analysis-2.15.0:'+contract.get('uploadCategory','other')+':'+contract.get('rawText','')).encode()).hexdigest()

def queue_analysis(server, identifier, force=False):
    from analysis_scope import classify_scoped
    with DB_LOCK:
        contract=get_record('contracts',identifier)
        if not contract:raise ValueError('合同不存在')
        signature=analysis_fingerprint(contract)
        pending=ANALYSIS_FUTURES.get(identifier)
        if contract.get('analysisFingerprint')==signature and ((not force and contract.get('analysisStatus')=='done') or (pending and not pending.done())):return contract
        if force and contract.get('knowledgeProfile'):
            contract['knowledgeProfile']={**contract['knowledgeProfile'],'tagSourceFingerprint':''}
        token=uuid.uuid4().hex;started=time.perf_counter()
        contract.update(managedBusinessAnalysis=True,needsExtraction=True,ruleAnalysisStatus='queued',ruleAnalysisError='',businessSnapshot=None,analysisStatus='queued',analysisRequest=token,analysisFingerprint=signature,analysisStartedAt=int(time.time()*1000),analysisError='',semanticTags=[],semanticNote='')
        put('contracts',identifier,contract)
        ANALYSIS_STATES[identifier]=analysis_state(contract)
        try:
            future=server.semantic_pool.submit(classify_scoped,contract.get('rawText',''),contract.get('uploadCategory','other'))
            ANALYSIS_FUTURES[identifier]=future
        except Exception as error:
            contract.update(analysisStatus='error',analysisError='分析启动失败，可重新分析：'+type(error).__name__)
            put('contracts',identifier,contract)
            ANALYSIS_STATES[identifier]=analysis_state(contract)
            return contract
        def completed(task):
            try:result=task.result();error=None
            except Exception as failure:result={};error=failure
            with DB_LOCK:
                current=get_record('contracts',identifier)
                if not current or current.get('analysisRequest')!=token or analysis_fingerprint(current)!=signature:return
                if error:current.update(analysisStatus='error',analysisError='业务分析失败，可重新分析：'+type(error).__name__)
                else:
                    current.update({k:v for k,v in result.items() if k in ['semanticTags','semanticModel','semanticNote','analysisScope']})
                    current.update(analysisStatus='done',analysisError='',analysisCompletedAt=int(time.time()*1000),analysisSeconds=round(time.perf_counter()-started,3))
                put('contracts',identifier,current)
                ANALYSIS_STATES[identifier]=analysis_state(current)
                if ANALYSIS_FUTURES.get(identifier) is task:ANALYSIS_FUTURES.pop(identifier,None)
        future.add_done_callback(completed)
        return contract


def submit_stored_job(server,job):
    from documents import recognize_document
    from concurrent.futures.process import BrokenProcessPool
    with JOB_LOCK:
        input_path=DATA_ROOT/'queue'/(job['id']+'.input')
        progress_path=DATA_ROOT/'queue'/(job['id']+'.progress.json')
        if not input_path.exists():
            original=source_path(job['id'])
            if not original.exists():raise ValueError('原文件未保留，请重新上传')
            input_path.write_bytes(original.read_bytes())
        cleanup_queue_file(progress_path.with_suffix('.cancel'))
        JOB_SAVE_ERRORS.pop(job['id'],None)
        job.update(status='queued',cancelRequested=False,retryAvailable=False)
        job.pop('error',None);job.pop('result',None)
        put('jobs',job['id'],job)
        from ocr_cache import cache_key,load as load_cached
        job['ocrCacheKey']=cache_key(input_path.read_bytes(),job['mode'],job['filename'])
        cached=load_cached(DATA_ROOT/'ocr_cache',job['ocrCacheKey'])
        if cached:
            future=concurrent.futures.Future();future.set_result(cached)
            finish_job(future,job,input_path,progress_path,server)
            return {'id':job['id'],'ocrCacheHit':True}
        args=(str(input_path),job['filename'],job['mode'],str(progress_path),job.get('uploadCategory','other'))
        coordinators=getattr(server,'coordinators',None)
        if coordinators is not None and job['filename'].lower().endswith('.pdf'):
            # Pages of one PDF are spread over every OCR process instead of one process doing
            # all pages in sequence; the coordinator keeps at most worker_count pages in flight.
            from documents import recognize_document_parallel
            future=coordinators.submit(recognize_document_parallel,lambda *task:submit_ocr(server,*task),*args,window=server.worker_count)
        else:
            future=submit_ocr(server,recognize_document,*args)
        JOB_FUTURES[job['id']]=future
        future.add_done_callback(lambda completed:finish_job(completed,job,input_path,progress_path,server))
        return {'id':job['id']}


POOL_LOCK = threading.Lock()


def submit_ocr(server, function, *args):
    from concurrent.futures.process import BrokenProcessPool
    with POOL_LOCK:
        try:
            return server.pool.submit(function, *args)
        except BrokenProcessPool:
            # A worker died (for example memory pressure); finished pages stay checkpointed.
            server.pool.shutdown(wait=False, cancel_futures=True)
            server.pool = create_ocr_pool(server.worker_count)
            return server.pool.submit(function, *args)


def ocr_threads(workers):
    # Split (estimated physical) cores between OCR processes. Never fewer threads than the
    # previous fixed setting with 1-2 workers; ONNX Runtime gains little beyond 4 threads.
    logical = os.cpu_count() or 2
    floor = max(1, min(2, logical // 2)) if workers <= 2 else 1
    return max(floor, min(4, (logical // 2) // max(1, workers)))


def create_ocr_pool(workers):
    # Spawned workers inherit the environment and size their ONNX thread pools from it.
    os.environ['CONTRACT_OCR_THREADS'] = str(ocr_threads(workers))
    return concurrent.futures.ProcessPoolExecutor(max_workers=workers,mp_context=multiprocessing.get_context('spawn'))


def machine_info():
    """CPU name, logical processors and memory, shown in settings to tune speed."""
    info = {'logicalProcessors': os.cpu_count()}
    try:
        if sys.platform == 'win32':
            import winreg, ctypes
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'HARDWARE\DESCRIPTION\System\CentralProcessor\0') as key:
                info['cpu'] = winreg.QueryValueEx(key, 'ProcessorNameString')[0].strip()
            class Memory(ctypes.Structure):
                _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(name, ctypes.c_ulonglong) for name in ['total', 'available', 'pageTotal', 'pageAvailable', 'virtualTotal', 'virtualAvailable', 'extended']]
            data = Memory(); data.length = ctypes.sizeof(data)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(data)):
                info['memoryGB'] = round(data.total / 1024 ** 3, 1); info['availableGB'] = round(data.available / 1024 ** 3, 1)
        else:
            import platform
            info['cpu'] = platform.processor() or platform.machine()
    except Exception:
        pass
    return info


def worker_count():
    settings=(get_record('config','main') or {}).get('value') or {}
    value=os.environ.get('CONTRACT_OCR_WORKERS',settings.get('nativeWorkers','auto'))
    if str(value) in ['1','2','3','4']:return int(value)
    # Two workers by default; one when available memory is very low; three on machines
    # with 12+ logical CPUs and ample free memory, since pages of one PDF now use every worker.
    if sys.platform=='win32':
        import ctypes
        class Memory(ctypes.Structure):
            _fields_=[('length',ctypes.c_ulong),('load',ctypes.c_ulong)]+[(name,ctypes.c_ulonglong) for name in ['total','available','pageTotal','pageAvailable','virtualTotal','virtualAvailable','extended']]
        data=Memory();data.length=ctypes.sizeof(data)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(data)):
            # A PP-OCRv4 worker peaks around 370 MB (measured), so two fit unless memory is very low.
            if data.available<int(1.2*1024**3):return 1
            if (os.cpu_count() or 2)>=12 and data.available>=6*1024**3:return 3
    return 2




def finish_job(future, job, input_path, progress_path,server=None):
    try:
        _finish_job(future,job,input_path,progress_path)
        JOB_SAVE_ERRORS.pop(job['id'],None)
    except Exception as error:
        with JOB_LOCK:
            job.update(status='error',retryAvailable=Path(input_path).exists(),error='保存结果失败：'+type(error).__name__+'；请检查磁盘空间后重试')
            JOB_FUTURES.pop(job['id'],None)
            try:put('jobs',job['id'],job)
            except OSError:JOB_SAVE_ERRORS[job['id']]=job
    if server and job.get('status')=='done':
        try:queue_analysis(server,job['id'])
        except Exception:pass  # OCR remains saved even when the independent analysis queue is unavailable.


def _finish_job(future, job, input_path, progress_path):
    result = None
    error = None
    try:
        result = future.result()
    except Exception as failure:
        error = failure
    with JOB_LOCK:
        latest = get_job(job['id']) or job
        if latest.get('cancelRequested') or Path(progress_path).with_suffix('.cancel').exists():
            job.update(status='cancelled', cancelRequested=True)
            job.pop('result', None)
        elif error is None:
            try:
                save_source(job['id'], Path(input_path).read_bytes())
                result['sourceAvailable'] = True
            except OSError:
                result['sourceAvailable'] = False
                result['sourceNote'] = '原件保存失败，请重新选择原文件'
            if job.get('ocrCacheKey') and not result.get('ocrCacheHit'):
                try:
                    from ocr_cache import save as cache_recognition
                    cache_recognition(DATA_ROOT/'ocr_cache',job['ocrCacheKey'],result)
                except OSError:pass
            result['id'] = job['id']
            # The result is stored once, in the contract; GET /api/jobs/<id> reads it from there.
            job.update(status='done', ocrSeconds=round(float(result.get('seconds') or 0),3))
            job.pop('result', None)
            contract = {'id': job['id'], 'projectName': Path(job['filename']).stem, 'sourceFile': job['filename'],
                        **{k:job[k] for k in UPLOAD_FIELDS if k in job},'uploadCategory':job.get('uploadCategory','other'),'managedBusinessAnalysis':True,'ruleAnalysisStatus':'queued','fileSize': job['fileSize'], 'createdAt': job['createdAt'], 'needsExtraction': True, **result}
            with DB_LOCK:
                existing=get_record('contracts',job['id']) or {}
                contract=merge_recovered(existing,contract)
                contract['ocrRevision']=uuid.uuid4().hex
                put('contracts',job['id'],contract)
        else:
            job.update(status='error', error='识别失败：' + str(error)[:160])
        job['retryAvailable']=job['status']=='error' or (job['status']=='done' and bool(result and result.get('failedPages')))
        put('jobs', job['id'], job)
        JOB_FUTURES.pop(job['id'], None)
        if not job['retryAvailable']:
            cleanup_queue_file(input_path)
            from recovery import clear_checkpoint
            clear_checkpoint(progress_path)
        cleanup_queue_file(progress_path)
        cleanup_queue_file(Path(progress_path).with_suffix('.cancel'))
        cleanup_queue_file(Path(progress_path).with_suffix('.tmp'))


def cancel_job(job_id):
    with JOB_LOCK:
        job = get_job(job_id)
        if job is None:
            return None
        if job['status'] in ['done', 'error', 'cancelled']:
            return {'status': job['status'], 'alreadyFinished': job['status'] == 'done'}
        progress_path = DATA_ROOT / 'queue' / (job_id + '.progress.json')
        progress_path.with_suffix('.cancel').write_text('cancel', encoding='ascii')
        job.update(status='cancelling', cancelRequested=True)
        put('jobs', job_id, job)
        future = JOB_FUTURES.get(job_id)
        if future is None:
            job.update(status='cancelled',retryAvailable=False)
            put('jobs',job_id,job)
            cleanup_queue_file(DATA_ROOT/'queue'/(job_id+'.input'))
            from recovery import clear_checkpoint
            clear_checkpoint(progress_path)
            return {'status':'cancelled'}
        if future is not None:
            future.cancel()  # Running processes stop cooperatively at the next safe boundary.
        return {'status': 'cancelling'}



def web_root():
    if getattr(sys, 'frozen', False):
        return Path(sys._MEIPASS) / 'web'
    return Path(__file__).resolve().parent.parent


class Handler(http.server.SimpleHTTPRequestHandler):
    server_version = 'ContractOCR/' + VERSION
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(web_root()), **kwargs)

    # Always serve current application code; Windows browsers may retain older scripts.
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'application/javascript', '.css': 'text/css'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()

    def log_message(self, *_):
        pass  # No document text, URLs or tokens in logs.

    def valid_host(self):
        return self.headers.get('Host') == f'{HOST}:{self.server.server_port}'

    def respond_raw(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def respond(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self.valid_host():
            return self.respond(403, {'error': 'Host not allowed'})
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith('/api/source/'):
            if not secrets.compare_digest(self.headers.get('X-OCR-Token', ''), TOKEN):
                return self.respond(403, {'error': 'Only this application can open originals'})
            identifier = urllib.parse.unquote(path.rsplit('/', 1)[1])
            contract = get_record('contracts', identifier)
            source = source_path(identifier)
            if contract is None or not source.is_file():
                return self.respond(404, {'error': '请为此记录选择原文件'})
            filename = contract.get('sourceFile', '').lower()
            mime = 'application/pdf' if filename.endswith('.pdf') else 'image/png' if filename.endswith('.png') else 'image/jpeg' if filename.endswith(('.jpg', '.jpeg')) else 'application/octet-stream'
            data = source.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(data)
            return
        if path == '/api/health':
            return self.respond(200, {'application': 'ContractOCR', 'version': VERSION, 'engine': 'native', 'workers': getattr(self.server,'worker_count',2), 'threads': ocr_threads(getattr(self.server,'worker_count',2)), 'machine': machine_info(), 'dataDirectory': str(DATA_ROOT), 'usage': storage_usage()})
        if path == '/api/analysis':
            with DB_LOCK:return self.respond(200,list(ANALYSIS_STATES.values()))
        if path == '/api/contracts':
            return self.respond_raw(raw_records('contracts'))
        if path == '/api/config':
            values = {item['key']: item['value'] for item in records('config')}
            values['uploaderDefault'] = default_uploader()
            values['cloudExcelDefault'] = DEFAULT_CLOUD_PATH
            return self.respond(200, values)
        if path == '/api/jobs':
            return self.respond(200, [{k: v for k, v in job.items() if k != 'result'} for job in job_records()])
        if path.startswith('/api/jobs/'):
            # Polled every 800 ms per running file: read only this job, never the whole library.
            job_id = urllib.parse.unquote(path.rsplit('/', 1)[1])
            job = get_job(job_id)
            if job is None:
                return self.respond(404, {'error': 'Job not found'})
            if job.get('status') == 'done':
                job['result'] = job_result(job)
            progress_path = DATA_ROOT / 'queue' / (job_id + '.progress.json')
            if progress_path.exists():
                try:
                    job['progress'] = json.loads(progress_path.read_text(encoding='utf-8'))
                except (OSError, ValueError):
                    pass
            return self.respond(200, job)
        if path in ['/', '/index.html']:
            html = (web_root() / 'index.html').read_text(encoding='utf-8')
            bootstrap = '<script>window.__LOCAL_OCR_TOKEN=' + json.dumps(TOKEN) + ';</script>'
            data = html.replace('</head>', bootstrap + '</head>').encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        # Serve only application assets, never arbitrary local files or test materials.
        clean = urllib.parse.unquote(path)
        if '..' in clean.split('/') or not clean.startswith(('/js/', '/css/', '/assets/', '/lib/')):
            return self.respond(404, {'error': 'Not found'})
        for header in ['If-Modified-Since', 'If-None-Match']:
            if header in self.headers:del self.headers[header]
        return super().do_GET()

    def do_POST(self):
        origin = f'http://{HOST}:{self.server.server_port}'
        if not self.valid_host() or self.headers.get('Origin') != origin or not secrets.compare_digest(self.headers.get('X-OCR-Token', ''), TOKEN):
            return self.respond(403, {'error': 'Only this application can call OCR'})
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path.startswith('/api/jobs/') and parsed.path.endswith('/discard'):
            length=int(self.headers.get('Content-Length','0'))
            if 0<length<=1024:self.rfile.read(length)
            identifier=parsed.path.split('/')[3]
            with JOB_LOCK:
                job=get_job(identifier)
                if not job or not (job.get('status') in ['error','cancelled'] or (job.get('status')=='done' and job.get('retryAvailable'))):return self.respond(409,{'error':'只能移除已停止的失败任务'})
                delete_record('jobs',identifier);JOB_SAVE_ERRORS.pop(identifier,None)
                cleanup_queue_file(DATA_ROOT/'queue'/(identifier+'.input'))
                from recovery import clear_checkpoint
                clear_checkpoint(DATA_ROOT/'queue'/(identifier+'.progress.json'))
            return self.respond(200,{'ok':True})
        if parsed.path.startswith('/api/jobs/') and parsed.path.endswith('/retry'):
            length=int(self.headers.get('Content-Length','0'))
            if 0<length<=1024:self.rfile.read(length)
            with JOB_LOCK:
                job=get_job(parsed.path.split('/')[3])
                if not job or not job.get('retryAvailable'):return self.respond(409,{'error':'此任务没有可恢复的失败内容'})
                try:return self.respond(202,submit_stored_job(self.server,job))
                except Exception as error:return self.respond(400,{'error':str(error)[:160]})
        if parsed.path=='/api/backup':
            return self.backup()
        if parsed.path.startswith('/api/source/'):
            identifier = urllib.parse.unquote(parsed.path.rsplit('/', 1)[1])
            contract = get_record('contracts', identifier)
            if contract is None:
                return self.respond(404, {'error': 'Contract not found'})
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 128 * 1024 * 1024:
                return self.respond(413, {'error': '文件为空或超过大小限制'})
            data = self.rfile.read(length)
            if len(data) != length:
                return self.respond(400, {'error': 'Incomplete source'})
            filename = urllib.parse.unquote(self.headers.get('X-Filename', ''))
            if Path(filename.replace('\\', '/')).name != contract.get('sourceFile'):
                return self.respond(400, {'error': '请选择与此合同文件名一致的原文件'})
            save_source(identifier, data)
            return self.respond(200, {'ok': True})
        if parsed.path.startswith('/api/jobs/') and parsed.path.endswith('/cancel'):
            length = int(self.headers.get('Content-Length', '0'))
            if 0 < length <= 1024: self.rfile.read(length)
            result = cancel_job(parsed.path.split('/')[3])
            return self.respond(200 if result is not None else 404, result or {'error': 'Job not found'})
        if parsed.path in ['/api/excel/export', '/api/excel/parse', '/api/excel/cloud-merge', '/api/excel/cloud-search']:
            return self.excel(parsed.path)
        if parsed.path in ['/api/jobs', '/api/contracts', '/api/config', '/api/semantic', '/api/analysis', '/api/business-analysis']:
            return self.mutate(parsed.path)
        if parsed.path != '/api/ocr':
            return self.respond(404, {'error': 'Not found'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BYTES:
                return self.respond(413, {'error': '图片为空或超过32MB'})
            mode = urllib.parse.parse_qs(parsed.query).get('mode', ['balanced'])[0]
            if mode not in ['fast', 'balanced', 'fine']:
                return self.respond(400, {'error': 'Unknown recognition mode'})
            data = self.rfile.read(length)
            if len(data) != length:
                return self.respond(400, {'error': 'Incomplete image'})
            result = self.server.pool.submit(recognize_image, data, mode).result(timeout=180)
            return self.respond(200, result)
        except concurrent.futures.TimeoutError:
            return self.respond(504, {'error': '本页识别超时，请使用快速模式或拆分大图'})
        except Exception:
            return self.respond(422, {'error': '本页识别失败，请检查图片或切换模式后重试'})


    def excel(self, path):
        """Contract-list Excel: build an .xlsx, read one back, or merge rows into the cloud-folder master table."""
        import excel_table
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= MAX_BYTES:
                return self.respond(413, {'error': '文件为空或超过32MB'})
            data = self.rfile.read(length)
            if len(data) != length:
                return self.respond(400, {'error': 'Incomplete request'})
            if path == '/api/excel/parse':
                headers, rows = excel_table.read_xlsx(data)
                return self.respond(200, {'headers': headers, 'rows': rows})
            payload = json.loads(data)
            configured = cloud_path()
            if path == '/api/excel/cloud-search':
                query = payload.get('query')
                if not isinstance(query, str) or len(query) > 200:
                    return self.respond(400, {'error': '请输入不超过 200 字的搜索关键词'})
                people = payload.get('people', {})
                eligible = payload.get('eligibleIds')
                direct = payload.get('directIds', [])
                related = payload.get('relatedIds', [])
                if (not isinstance(people, dict)
                        or not all(key in ('person', 'pic', 'eic') and isinstance(value, str)
                                   for key, value in people.items())
                        or not all(isinstance(ids, list) and all(isinstance(i, str) for i in ids)
                                   for ids in (direct, related, eligible if eligible is not None else []))):
                    return self.respond(400, {'error': '搜索筛选条件格式不正确'})
                return self.respond(200, excel_table.search_master(
                    configured, query, people, set(eligible) if eligible is not None else None,
                    set(direct), set(related), payload.get('matchAny') is True))
            rows = payload.get('rows')
            if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
                return self.respond(400, {'error': '表格数据格式不正确'})
            # 上传者ID comes from this computer's contract records, never from the browser or an edited Excel row.
            for row in rows:
                contract = get_record('contracts', row.get('合同ID')) if isinstance(row.get('合同ID'), str) and row.get('合同ID') else None
                row['上传者ID'] = (contract or {}).get('uploadedByName') or uploader_name()
            if path == '/api/excel/export':
                body = excel_table.write_xlsx(excel_table.COLUMNS, rows)
                self.send_response(200)
                self.send_header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                self.wfile.write(body)
                return None
            with EXCEL_LOCK:
                return self.respond(200, excel_table.merge_into_master(configured, rows))
        except excel_table.ExcelError as error:
            return self.respond(422, {'error': str(error)})
        except Exception as error:
            if os.environ.get('CONTRACT_OCR_DIAGNOSTICS') == '1':
                import traceback
                traceback.print_exc()
            return self.respond(400, {'error': 'Excel 处理失败：' + type(error).__name__})

    def mutate(self, path):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            maximum = 128 * 1024 * 1024 if path == '/api/jobs' else MAX_BYTES
            if not 0 < length <= maximum:
                return self.respond(413, {'error': '文件为空或超过大小限制'})
            data = self.rfile.read(length)
            if len(data) != length:
                return self.respond(400, {'error': 'Incomplete request'})
            if path == '/api/jobs':
                with JOB_LOCK:
                    from documents import recognize_document
                    active = [job for job in job_records() if job['status'] in ['queued', 'running', 'cancelling']]
                    if len(active) >= 20:
                        return self.respond(429, {'error': '已有20个任务，请等待后继续添加'})
                    filename = Path(urllib.parse.unquote(self.headers.get('X-Filename', 'document.pdf')).replace('\\', '/')).name
                    mode = self.headers.get('X-OCR-Mode', 'balanced')
                    if mode not in ['fast', 'balanced', 'fine']:
                        return self.respond(400, {'error': 'Unknown recognition mode'})
                    category=self.headers.get('X-Upload-Category','other')
                    if category not in ['ey-template','other']:return self.respond(400,{'error':'Unknown upload category'})
                    job_id = 'job_' + uuid.uuid4().hex
                    input_path = DATA_ROOT / 'queue' / (job_id + '.input')
                    progress_path = DATA_ROOT / 'queue' / (job_id + '.progress.json')
                    input_path.write_bytes(data)
                    job = {'id': job_id, 'filename': filename, 'fileSize': length, 'mode': mode, 'uploadCategory':category,'status': 'queued', 'createdAt': int(time.time() * 1000)}
                    job.update(uploadedByName=uploader_name(),uploadedAt=job['createdAt'])
                    put('jobs', job_id, job)
                    submit_stored_job(self.server,job)
                    return self.respond(202, {'id': job_id})
            payload = json.loads(data)
            if path == '/api/business-analysis':
                identifier=payload.get('id')
                with DB_LOCK:
                    current=get_record('contracts',identifier)
                    if not current:return self.respond(404,{'error':'合同不存在'})
                    if payload.get('request')!=current.get('analysisRequest') or payload.get('revision')!=current.get('ocrRevision') or current.get('analysisStatus') not in ['done','error']:
                        return self.respond(409,{'error':'原文或分析任务已更新，旧分析结果已忽略'})
                    if payload.get('error'):
                        current.update(ruleAnalysisStatus='error',ruleAnalysisError=str(payload['error'])[:200])
                    else:
                        snapshot=payload.get('snapshot')
                        if not isinstance(snapshot,dict) or snapshot.get('schema')!=1 or snapshot.get('request')!=current.get('analysisRequest') or snapshot.get('revision')!=current.get('ocrRevision'):
                            return self.respond(400,{'error':'分析结果格式不正确'})
                        fields=payload.get('fields',{})
                        if not current.get('manualFieldsEditedAt'):
                            for field in ['projectName','projectNameSource','projectNameEvidence','identityExtractionVersion','partyA','partyB','signDate','content','deliverables']:
                                if field in fields:current[field]=fields[field]
                            if not current.get('amountManuallyEdited') and 'amount' in fields:current['amount']=fields['amount']
                        current.update(businessSnapshot=snapshot,ruleAnalysisStatus='done',ruleAnalysisError='',ruleAnalysisSeconds=max(0,float(payload.get('seconds',0))),needsExtraction=False)
                    put('contracts',identifier,current);ANALYSIS_STATES[identifier]=analysis_state(current)
                    return self.respond(200,{'contract':current})
            if path == '/api/analysis':
                identifier=payload.get('id')
                if not isinstance(identifier,str) or not get_record('contracts',identifier):return self.respond(404,{'error':'合同不存在'})
                contract=queue_analysis(self.server,identifier,force=bool(payload.get('force',True)))
                return self.respond(202,{'id':identifier,'analysisStatus':contract['analysisStatus']})
            if path == '/api/semantic':
                from analysis_scope import classify_scoped
                category=payload.get('uploadCategory','other')
                if category not in ['ey-template','other']:return self.respond(400,{'error':'Unknown upload category'})
                return self.respond(200,self.server.semantic_pool.submit(classify_scoped,payload.get('text',''),category).result(timeout=180))
            if path == '/api/config':
                key = payload.get('key')
                if key == 'cloudExcel':
                    return self.respond(403, {'error': '秘书端云盘路径由代码统一配置'})
                if key not in ['main', 'keywordPool', 'serviceDomains', 'cloudExcel', 'uploader']:
                    return self.respond(400, {'error': 'Invalid config key'})
                put('config', key, {'key': key, 'value': payload.get('value')})
                return self.respond(200, {'ok': True})
            action = payload.get('action')
            if action == 'clear':
                with JOB_LOCK,DB_LOCK:
                    if any(job.get('status') in ['queued', 'running', 'cancelling'] for job in job_records()):
                        return self.respond(409, {'error': '后台任务仍在运行，请完成后再清空合同数据'})
                    clear_records('contracts')
                    clear_records('jobs')
                    JOB_SAVE_ERRORS.clear()
                    import shutil
                    for checkpoint in (DATA_ROOT/'checkpoints').iterdir():
                        if checkpoint.is_dir():shutil.rmtree(checkpoint,ignore_errors=True)
                    for queued in (DATA_ROOT/'queue').glob('*'):cleanup_queue_file(queued)
                    for source in (DATA_ROOT / 'sources').glob('*.bin'): source.unlink(missing_ok=True)
                    shutil.rmtree(DATA_ROOT/'ocr_cache',ignore_errors=True)
                    for future in list(ANALYSIS_FUTURES.values()):future.cancel()
                    ANALYSIS_FUTURES.clear();ANALYSIS_STATES.clear()
            elif action == 'delete':
                with JOB_LOCK,DB_LOCK:
                    previous_job=get_job(payload['id']) or {}
                    if previous_job.get('ocrCacheKey'):(DATA_ROOT/'ocr_cache'/(previous_job['ocrCacheKey']+'.json')).unlink(missing_ok=True)
                    delete_record('contracts', payload['id'])
                    ANALYSIS_STATES.pop(payload['id'],None)
                    pending=ANALYSIS_FUTURES.pop(payload['id'],None)
                    if pending:pending.cancel()
                    delete_record('jobs', payload['id'])
                    from recovery import clear_checkpoint
                    clear_checkpoint(DATA_ROOT/'queue'/(payload['id']+'.progress.json'))
                    cleanup_queue_file(DATA_ROOT/'queue'/(payload['id']+'.input'))
                    source_path(payload['id']).unlink(missing_ok=True)
            elif action in ['add', 'update', 'batch']:
                items = payload['contracts'] if action == 'batch' else [payload['contract']]
                for contract in items:
                    if not isinstance(contract.get('id'), str):
                        return self.respond(400, {'error': 'Missing contract id'})
                saved=[]
                with DB_LOCK:
                    for contract in items:
                        existing=get_record('contracts',contract['id'])
                        if action=='update' and existing and existing.get('ocrRevision') and contract.get('ocrRevision')!=existing['ocrRevision']:
                            return self.respond(409,{'error':'识别结果已更新，请刷新后再保存；当前草稿可先复制保留'})
                        if action=='batch' and existing:continue
                        if action=='add' and existing:contract=merge_recovered(existing,contract)
                        stamp_uploader(contract,existing)
                        changed=bool(existing and analysis_fingerprint(existing)!=analysis_fingerprint(contract))
                        if existing and not changed:
                            if existing.get('managedBusinessAnalysis'):contract['needsExtraction']=existing.get('needsExtraction',True)
                            for field in ANALYSIS_FIELDS:
                                if field in existing:contract[field]=existing[field]
                        if changed:contract.update(analysisStatus='queued',semanticTags=[],analysisRequest=uuid.uuid4().hex,ocrRevision=uuid.uuid4().hex)
                        put('contracts',contract['id'],contract);saved.append(contract)
                        if changed:
                            queued=queue_analysis(self.server,contract['id']);saved[-1]=queued
                return self.respond(200,{'ok':True,'contracts':saved})
            else:
                return self.respond(400, {'error': 'Invalid action'})
            return self.respond(200, {'ok': True})
        except Exception as error:
            if os.environ.get('CONTRACT_OCR_DIAGNOSTICS') == '1':
                import traceback
                traceback.print_exc()
                return self.respond(400, {'error': type(error).__name__ + ': ' + str(error)[:200]})
            return self.respond(400, {'error': '本地数据操作失败，请检查可用磁盘空间'})

    def backup(self):
        import zipfile,tempfile,shutil
        # Spill large archives to disk; do not hold all original documents in RAM.
        sent=False
        try:
            with tempfile.SpooledTemporaryFile(max_size=8*1024**2,dir=DATA_ROOT) as output:
                with JOB_LOCK,DB_LOCK,zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
                    missing=[]
                    for contract in records('contracts'):
                        archive.writestr('contracts/'+record_path('contracts',contract['id']).name,json.dumps(contract,ensure_ascii=False))
                        source=source_path(contract['id'])
                        if source.exists():archive.write(source,'sources/'+source.name)
                        else:missing.append(contract['id'])
                    for config in (DATA_ROOT/'config').glob('*.json'):archive.write(config,'config/'+config.name)
                    archive.writestr('backup_manifest.json',json.dumps({'version':VERSION,'missingOriginals':missing,'scope':'saved contracts, annotations, configuration and available originals'},ensure_ascii=False))
                length=output.tell();output.seek(0)
                self.send_response(200);self.send_header('Content-Type','application/zip');self.send_header('Content-Length',str(length));self.send_header('Cache-Control','no-store');self.end_headers();sent=True
                shutil.copyfileobj(output,self.wfile,length=1024*1024)
        except OSError:
            # If headers were already sent, the client observes an incomplete download.
            if sent:
                self.close_connection=True
                return
            return self.respond(507,{'error':'备份失败，请检查磁盘空间'})


def main():
    multiprocessing.freeze_support()
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    if sys.platform == 'win32':
        import ctypes
        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
    try:
        server = http.server.ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        print(f'{PORT}端口已被占用。如程序已打开，请使用已有窗口；否则关闭旧程序后重试。')
        return
    initialize_store()
    from semantic import initialize_worker
    semantic_pool = concurrent.futures.ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context('spawn'), initializer=initialize_worker)
    server.worker_count=worker_count()
    pool=create_ocr_pool(server.worker_count)
    server.pool = pool
    # Two documents are coordinated at a time (as before); their pages share all OCR processes.
    server.coordinators = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix='ocr-document')
    server.semantic_pool = semantic_pool
    for job in job_records():
        if job.get('status')=='interrupted':
            try:submit_stored_job(server,job)
            except Exception:
                job.update(status='error',retryAvailable=True,error='恢复任务启动失败，可点击重试')
                put('jobs',job['id'],job)
    for contract in records('contracts'):
        ANALYSIS_STATES[contract['id']]=analysis_state(contract)
        if contract.get('engine')=='native' and not contract.get('managedBusinessAnalysis'):
            queue_analysis(server,contract['id'],force=True)
        elif contract.get('analysisStatus') in ['queued','running']:
            queue_analysis(server,contract['id'])
        elif contract.get('managedBusinessAnalysis') and contract.get('analysisStatus')=='done' and contract.get('analysisFingerprint')!=analysis_fingerprint(contract):
            # 2.15.0 关键词规则更精确（服务分项标题、标准与体系名称、SOC 写法统一、客户系统名称），
            # 已有合同在后台重新分析一次；手动改过的关键词 / 标签不会被覆盖。
            try:queue_analysis(server,contract['id'])
            except Exception:
                pass  # 重新分析失败不影响启动，原结果保留，可在详情页重新分析
    print(f'合同识别 {VERSION}：正在启动本机OCR引擎，首次识别稍需等待。')
    print(f'打开 http://{HOST}:{PORT}；所有文件均在本机处理。关闭此窗口可停止服务。')
    if '--no-browser' not in sys.argv:
        webbrowser.open(f'http://{HOST}:{PORT}')
    if sys.platform != 'win32':
        def stop(*_):
            raise KeyboardInterrupt
        signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.coordinators.shutdown(wait=False, cancel_futures=True)
        server.pool.shutdown(wait=True, cancel_futures=True)
        semantic_pool.shutdown(wait=True, cancel_futures=True)


if __name__ == '__main__':
    main()
