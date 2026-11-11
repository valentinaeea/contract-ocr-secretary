"""Runs the actual Mac launcher using only synthetic fixtures and a temporary contract store."""
from pathlib import Path
import io,os,socket,subprocess,tempfile,time,urllib.request
ROOT=Path(__file__).resolve().parents[1]
def main():
 import pymupdf as fitz
 from PIL import Image,ImageDraw,ImageFont
 with tempfile.TemporaryDirectory(prefix='contract-secretary-test-') as directory:
  work=Path(directory);font=ImageFont.truetype('/System/Library/Fonts/STHeiti Light.ttc',40)
  text='虚构测试合同\n甲方：虚构甲方股份有限公司\n乙方：虚构乙方有限公司\n签订日期：2026年11月11日\n服务内容：ITGC 风险评估、权限管理和控制测试。'
  image=Image.new('RGB',(1700,700),'white');ImageDraw.Draw(image).multiline_text((40,40),text,font=font,fill='black',spacing=25);image.save(work/'image.png')
  doc=fitz.open()
  for _ in range(2):doc.new_page().insert_textbox(fitz.Rect(40,40,550,750),text,fontname='china-s',fontsize=18)
  doc.save(work/'text.pdf');doc.close()
  doc=fitz.open();page=doc.new_page(width=850,height=350);page.insert_image(page.rect,filename=str(work/'image.png'));doc.save(work/'scan.pdf');doc.close()
  with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
  origin=f'http://127.0.0.1:{port}'
  with (work/'service.log').open('w') as log:
   process=subprocess.Popen([str(ROOT/'start-mac.command'),'--no-browser'],env={**os.environ,'CONTRACT_OCR_DATA_DIR':str(work/'private-data'),'CONTRACT_OCR_PORT':str(port),'CONTRACT_OCR_CLOUD_DEFAULT':str(work/'cloud'),'CONTRACT_OCR_WORKERS':'2','USERNAME':'fictional-secretary'},stdout=log,stderr=log)
   try:
    for _ in range(300):
     try:urllib.request.urlopen(origin+'/api/health',timeout=1);break
     except Exception:
      if process.poll() is not None:raise RuntimeError((work/'service.log').read_text())
      time.sleep(.1)
    result=subprocess.run(['node',str(ROOT/'tests/secretary_browser.cjs')],cwd=ROOT,env={**os.environ,'TEST_ORIGIN':origin,'TEST_WORK':str(work),'PYTHON':str(ROOT/'.venv/bin/python')},capture_output=True,text=True)
    print(result.stdout)
    if result.returncode:print(result.stderr);raise SystemExit(result.returncode)
   finally:
    process.terminate()
    try:process.wait(30)
    except subprocess.TimeoutExpired:process.kill();process.wait()
if __name__=='__main__':main()
