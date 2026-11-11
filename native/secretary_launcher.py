"""Mac launcher for the secretary copy; the original service/algorithms are unchanged."""
from pathlib import Path
import os
import signal
import socket
import subprocess
import sys


def main():
    root=Path(__file__).resolve().parents[1]
    for stream in (sys.stdout,sys.stderr):
        if hasattr(stream,'reconfigure'):stream.reconfigure(encoding='utf-8',errors='replace')
    import numpy,onnxruntime,pymupdf,tokenizers
    from PIL import Image
    import rapidocr_onnxruntime
    env=os.environ.copy()
    env.setdefault('CONTRACT_OCR_DATA_DIR',str(Path.home()/'Library/Application Support/ContractOCR-Secretary-Local/LocalData'))
    env['TOKENIZERS_PARALLELISM']='false'
    env['PYTHONUTF8']='1'
    ports=[int(env['CONTRACT_OCR_PORT'])] if env.get('CONTRACT_OCR_PORT') else range(18770,18870)
    for port in ports:
        with socket.socket() as probe:
            try:probe.bind(('127.0.0.1',port))
            except OSError:continue
            break
    else:raise RuntimeError('本机端口被占用，请关闭旧测试启动窗口后重试')
    env['CONTRACT_OCR_PORT']=str(port)
    print('秘书端本地测试版：http://127.0.0.1:'+str(port),flush=True)
    print('使用期间保留此窗口；数据与原项目分开保存。',flush=True)
    child=subprocess.Popen([sys.executable,str(root/'native/desktop.py'),*sys.argv[1:]],cwd=root,env=env)
    previous=signal.signal(signal.SIGTERM,lambda *_:child.terminate())
    try:
        try:return child.wait()
        except KeyboardInterrupt:
            try:return child.wait(timeout=30)
            except subprocess.TimeoutExpired:child.terminate();return child.wait(timeout=30)
    finally:
        if child.poll() is None:child.kill();child.wait()
        signal.signal(signal.SIGTERM,previous)


if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception:
        import traceback
        traceback.print_exc()
        try:input('启动失败，请保留错误信息。按回车关闭……')
        except EOFError:pass
        raise SystemExit(1)
