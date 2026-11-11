"""Durable page checkpoints. No model calls or network access."""
import hashlib
import json
import os
from pathlib import Path
import shutil

def checkpoint_dir(progress_path):
    path=Path(progress_path)
    return path.parent.parent/'checkpoints'/hashlib.sha256(path.name.encode()).hexdigest()

class PageCheckpoint:
    def __init__(self, progress_path, data, mode, digest=None):
        self.root=checkpoint_dir(progress_path)
        # Parallel page workers receive the input digest instead of rehashing the file per page.
        # Model set is part of the key: pages read by PP-OCRv4 are not reused for PP-OCRv5.
        from engine import model_tag
        self.key=(digest or hashlib.sha256(data).hexdigest())+':'+mode+':2.14.0:'+model_tag(mode)+'/'+model_tag('fine')
    def load(self, page):
        try:
            record=json.loads((self.root/f'{page}.json').read_text(encoding='utf-8'))
            result=record.get('result')
            if record.get('key')!=self.key or not isinstance(result,dict):return None
            if not all(key in result for key in ['text','layout','audit','notes','ocrUsed']):return None
            if not isinstance(result['text'],str) or not isinstance(result['layout'],dict) or not isinstance(result['audit'],dict) or not isinstance(result['notes'],list):return None
            return result
        except (OSError,ValueError,KeyError,TypeError):return None
    def save(self,page,result):
        self.root.mkdir(parents=True,exist_ok=True)
        import uuid
        path=self.root/f'{page}.json'; temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
        with temporary.open('w',encoding='utf-8') as stream:
            json.dump({'key':self.key,'result':result},stream,ensure_ascii=False)
            stream.flush();os.fsync(stream.fileno())
        temporary.replace(path)

def clear_checkpoint(progress_path):
    shutil.rmtree(checkpoint_dir(progress_path),ignore_errors=True)

def peak_memory_mb():
    try:
        import sys
        if sys.platform=='win32':
            import ctypes
            from ctypes import wintypes
            class Counters(ctypes.Structure):
                _fields_=[('cb',wintypes.DWORD),('PageFaultCount',wintypes.DWORD)]+[(name,ctypes.c_size_t) for name in ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage']]
            data=Counters();data.cb=ctypes.sizeof(data)
            kernel=ctypes.WinDLL('kernel32');kernel.GetCurrentProcess.restype=wintypes.HANDLE
            api=ctypes.WinDLL('psapi').GetProcessMemoryInfo;api.argtypes=[wintypes.HANDLE,ctypes.c_void_p,wintypes.DWORD]
            if api(kernel.GetCurrentProcess(),ctypes.byref(data),data.cb):return round(data.PeakWorkingSetSize/1024**2,1)
        else:
            import resource
            return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024,1)
    except Exception:pass
    return None
