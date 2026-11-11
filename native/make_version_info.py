"""Write a Windows version resource for PyInstaller (--version-file).

Executables without product/company/version metadata are treated more suspiciously by
antivirus heuristics. The version comes from native/desktop.py so it always matches the app.
"""
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parent
version = re.search(r"VERSION = '([\d.]+)'", (root / 'desktop.py').read_text(encoding='utf-8')).group(1)
parts = [int(part) for part in version.split('.')] + [0] * (4 - len(version.split('.')))
numbers = ', '.join(str(part) for part in parts[:4])
text = f"""VSVersionInfo(
  ffi=FixedFileInfo(filevers=({numbers}), prodvers=({numbers}), mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('080404b0', [
      StringStruct('CompanyName', 'ClaudiaYee'),
      StringStruct('FileDescription', 'Contract OCR - offline contract recognition and analysis'),
      StringStruct('FileVersion', '{version}'),
      StringStruct('InternalName', 'ContractOCR'),
      StringStruct('LegalCopyright', 'ClaudiaYee'),
      StringStruct('OriginalFilename', 'ContractOCR.exe'),
      StringStruct('ProductName', 'Contract OCR Local'),
      StringStruct('ProductVersion', '{version}')])]),
    VarFileInfo([VarStruct('Translation', [0x0804, 1200])])
  ]
)
"""
target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('version_info.txt')
target.write_text(text, encoding='utf-8')
print(f'Version resource {version} -> {target}')
