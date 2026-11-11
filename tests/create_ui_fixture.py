"""Generate synthetic text and scanned PDFs for upload-to-tag UI tests."""
import io,sys
from pathlib import Path
import pymupdf as fitz
from PIL import Image,ImageDraw,ImageFont
out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
text='Synthetic ITGC Assurance Service Agreement\nScope of services:\nWe will perform SOC 1 Type II assurance and ITGC testing for SAP.\nDeliverables: SOC 1 Type II report.\nSynthetic UI upload contract.'
pdf=fitz.open();page=pdf.new_page(width=850,height=600);page.insert_text((50,90),text,fontsize=18);pdf.save(out/'integration-text.pdf');pdf.close()
image=Image.new('RGB',(1800,1100),'white');draw=ImageDraw.Draw(image)
fonts=['C:/Windows/Fonts/arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'];font=next((ImageFont.truetype(f,64) for f in fonts if Path(f).exists()),ImageFont.load_default())
for i,line in enumerate(['Scope of services:','We will perform ITGC testing','for SAP systems.','Synthetic scanned contract.']):draw.text((90,150+i*150),line,font=font,fill='black')
buf=io.BytesIO();image.save(buf,format='PNG');pdf=fitz.open();page=pdf.new_page(width=900,height=550);page.insert_image(page.rect,stream=buf.getvalue());pdf.save(out/'integration-scan.pdf');pdf.close()

for filename,content in [
 ('integration-ey-template.pdf','Synthetic Consulting Service Agreement\nScope of services:\nWe will perform data migration.\nAppendix I Statement of Work\nScope of services:\nWe will perform ITGC testing for SAP.\nAppendix II Other Terms\nScope of services:\nWe will provide process optimization.'),
 ('integration-ey-missing.pdf','Synthetic Other Service Agreement\nScope of services:\nWe will perform ITGC testing and data migration.')]:
    pdf=fitz.open();page=pdf.new_page(width=900,height=1000);page.insert_text((50,80),content,fontsize=18);pdf.save(out/filename);pdf.close()

# Synthetic EY letter: explicit field competes with a wrapped subject title.
subject='示例云端科技（集团）有限公司之SOC2类型一及类型二报告鉴证服务'
content='项目名称：信息系统服务项目\n敬启者：\n关于：\n'+subject+'\n业务约定书\n我们将提供以下服务。\n附录一 工作说明书\n服务内容：提供ITGC及权限管理评估。\n附录二 其他条款\n服务费用：18万元。'
pdf=fitz.open();page=pdf.new_page(width=1000,height=1000);page.insert_text((45,65),content,fontname='china-s',fontsize=16);pdf.save(out/'integration-ey-subject.pdf');pdf.close()
