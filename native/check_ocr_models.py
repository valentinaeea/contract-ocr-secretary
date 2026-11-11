"""Build-time check that bundled PP-OCRv5 weights load in the shipped engine and read text.

Uses a synthetic printed contract line only (no client data). Verifies:
  * the dictionary matches the recognition model's output classes (wrong dict = garbage text)
  * every recognition profile reads a date and an amount correctly through engine.recognize_image
Printed text cannot prove handwriting accuracy; it proves the models are wired correctly.
"""
import io
import json
from pathlib import Path
import re
import sys

# Windows build consoles default to cp1252; the report contains Chinese text.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8', errors='replace')
sys.path.insert(0, str(Path(__file__).resolve().parent))
import engine  # noqa: E402

root = engine.MODEL_ROOT
missing = [name for name in engine.FILES.values() if not (root / name).is_file()]
# Mobile v5 files are still downloaded (dictionary cross-check) but whole pages use v4.
if missing:
    raise SystemExit('Missing PP-OCRv5 files: ' + ', '.join(missing))

import onnxruntime as ort  # noqa: E402
keys = (root / engine.FILES['keys']).read_text(encoding='utf-8').splitlines()
for name in ('rec_server',):
    session = ort.InferenceSession(str(root / engine.FILES[name]), providers=['CPUExecutionProvider'])
    classes = session.get_outputs()[0].shape[-1]
    # CTC classes = blank + dictionary + space.
    if isinstance(classes, int) and classes != len(keys) + 2:
        raise SystemExit(f'{name}: model has {classes} classes but dictionary gives {len(keys) + 2}')

from PIL import Image, ImageDraw, ImageFont  # noqa: E402
fonts = [Path(p) for p in ('C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simsun.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')]
font_path = next((path for path in fonts if path.exists()), None)
if font_path:
    lines, expected = ['签订日期：2026年11月6日', '合同金额：人民币180,000.25元'], ['2026年11月6日', '180,000.25']
else:
    lines, expected = ['Signed on 2026-11-06', 'Amount 180,000.25'], ['2026-11-06', '180,000.25']
font = ImageFont.truetype(str(font_path), 44) if font_path else ImageFont.load_default(size=44)
image = Image.new('RGB', (1100, 260), 'white')
draw = ImageDraw.Draw(image)
for index, line in enumerate(lines):
    draw.text((40, 40 + index * 100), line, fill='black', font=font)
buffer = io.BytesIO(); image.save(buffer, format='PNG')

report = {}
for mode in ('fast', 'balanced', 'fine'):
    result = engine.recognize_image(buffer.getvalue(), mode)
    compact = re.sub(r'\s+', '', result['text'])
    report[mode] = {'model': result['ocrModel'], 'text': result['text']}
    for item in expected:
        if item not in compact:
            raise SystemExit(f'{mode} ({result["ocrModel"]}) misread {item!r}: {result["text"]!r}')
# Diagnostic only: how each mode spaces English words (reported, not enforced).
english = Image.new('RGB', (1100, 120), 'white')
ImageDraw.Draw(english).text((40, 30), 'AUDIT CONTRACT Statement of Work SOC 2 Type II', fill='black', font=font)
english_buffer = io.BytesIO(); english.save(english_buffer, format='PNG')
for mode in ('fast', 'balanced', 'fine'):
    report[mode]['english'] = engine.recognize_image(english_buffer.getvalue(), mode)['text']
tags = {mode: engine.model_tag(mode).replace('+int8det', '') for mode in ('fast', 'balanced', 'fine')}
if tags != {'fast': 'v4', 'balanced': 'v4+datevote', 'fine': 'v4+v5server+datevote'}:
    raise SystemExit('Unexpected model profiles: ' + json.dumps({m: engine.model_tag(m) for m in ('fast', 'balanced', 'fine')}))
# Server recognizer: only used on short key-line crops (精细). Check it reads the date line.
import numpy as np  # noqa: E402
date_crop = np.ascontiguousarray(np.asarray(image.crop((20, 25, 760, 105)).convert('RGB'))[:, :, ::-1])
import time  # noqa: E402
started = time.perf_counter()
server_text, server_score = engine.recognize_lines([date_crop])[0]
report['serverKeyLine'] = {'text': server_text, 'score': round(server_score, 3), 'seconds': round(time.perf_counter() - started, 2)}
if expected[0] not in re.sub(r'\s+', '', server_text):
    raise SystemExit(f'Server recognizer misread {expected[0]!r}: {server_text!r}')
# int8 detector gate: must read the degraded synthetic set at least as accurately as fp32.
int8_path = root / engine.INT8_DET
if int8_path.is_file():
    import difflib
    from PIL import ImageFilter
    from rapidocr_onnxruntime import RapidOCR
    from rapidocr_onnxruntime.ch_ppocr_det.utils import DetPreProcess
    gate_lines = ['本工作说明书（以下简称“本说明书”）于2025年11月19日由安永华明会计师事务所', '根据2026年10月安永和贵公司之间签订的协议', '安永将基于如下标准执行针对贵公司2026年11月至2026年12月31日期间的',
                  '可信服务之关于安全性、可用性、进程完整性、保密性和隐私性的标准', '广州视睿电子科技有限公司', '提供SOC2类型二报告，并依据ISO 27001:2022开展评估', '合同总金额为人民币180,000.00元']
    def degraded(size, blur, noise, quality):
        page = Image.new('L', (1820, len(gate_lines) * size * 2 + 80), 236); draw_page = ImageDraw.Draw(page)
        gate_font = ImageFont.truetype(str(font_path), size) if font_path else ImageFont.load_default(size=size)
        for index, line in enumerate(gate_lines): draw_page.text((110, 40 + index * size * 2), line, fill=40, font=gate_font)
        if blur: page = page.filter(ImageFilter.GaussianBlur(blur))
        pixels = np.asarray(page).astype(np.int16) + np.random.default_rng(0).normal(0, noise, page.size[::-1]).astype(np.int16)
        page = Image.fromarray(np.clip(pixels, 0, 255).astype(np.uint8)); buffer_ = io.BytesIO(); page.save(buffer_, 'JPEG', quality=quality)
        return np.ascontiguousarray(np.asarray(Image.open(buffer_).convert('RGB'))[:, :, ::-1])
    images = [degraded(*args) for args in [(30, 0, 0, 95), (30, .8, 10, 55), (26, 1.0, 12, 50), (34, .6, 8, 60)]]
    content = lambda text: re.sub(r'[^0-9A-Za-z\u4e00-\u9fff]', '', text)  # judge characters/digits, not quote styles
    expected_text = content(''.join(gate_lines))
    def evaluate(det_path):
        options = {'det_model_path': str(det_path)} if det_path else {}
        ocr = RapidOCR(intra_op_num_threads=2, **options); det = ocr.text_det
        det.get_preprocess = lambda _: DetPreProcess(1920, 'max', det.mean, det.std)
        errors = 0; started_at = time.perf_counter()
        for image in images:
            found, _ = ocr(image, use_cls=False, text_score=engine.TEXT_SCORE)
            got = content(engine.fix_confusables(''.join(item[1] for item in (found or []))))
            errors += sum(max(i2 - i1, j2 - j1) for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, expected_text, got, autojunk=False).get_opcodes() if op != 'equal')
        return errors, round(time.perf_counter() - started_at, 2)
    fp32 = evaluate(None); int8 = evaluate(int8_path)
    report['int8DetectorGate'] = {'fp32': {'errors': fp32[0], 'seconds': fp32[1]}, 'int8': {'errors': int8[0], 'seconds': int8[1]}}
    if int8[0] > fp32[0]:
        int8_path.unlink()
        report['int8DetectorGate']['decision'] = 'rejected: less accurate, original detector used'
    else:
        report['int8DetectorGate']['decision'] = 'accepted'
print(json.dumps(report, ensure_ascii=False, indent=2))
print('Bundled OCR models verified with a synthetic printed line.')
