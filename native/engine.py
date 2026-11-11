"""OCR engine functions in an importable module for frozen multiprocessing.

Whole pages are always read by the bundled PP-OCRv4 mobile detector + recognizer. Measured on
scan-like contract pages (v2.14.3): v4 makes only punctuation-width slips, while the
PP-OCRv5 *mobile* recognizer drops common characters (月 日 行 工 用 金 至 广 子), so it is
not used. The PP-OCRv5 *server* recognizer read every test line correctly (incl. SOC2,
ISO 27001:2022, 180,000.00) but needs ~2 s per line and ~260 s per page on CPU, so it only
re-reads a few short key lines per page (dates, amounts, codes, low confidence):
  fast     v4, 160 dpi, no key-line review
  balanced v4, 220 dpi (server review measured +10 s/page with no gain on printed text)
  fine     v4, 300 dpi, up to 6 key lines per page via PP-OCRv5 server (handwriting)
"""
from pathlib import Path
import io
import os
import re
import sys
import time

ENGINE = None          # Kept for compatibility: the page engine once loaded.
ENGINES = {}
MODEL_ROOT = Path(os.environ.get('CONTRACT_OCR_MODEL_DIR', str(Path(sys._MEIPASS) / 'ocr_models' if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent.parent / 'models' / 'ocr_models')))
FILES = {'rec_server': 'ppocrv5_rec_server.onnx', 'rec_mobile': 'ppocrv5_rec_mobile.onnx', 'keys': 'ppocrv5_dict.txt'}
# int8 PP-OCRv4 detector (built and accuracy-checked at build time). Measured: same text as
# the original detector on the degraded test set, ~22% less time per page. Recognition stays
# fp32: the int8 recognizer misread characters (睿->容, ISO->/S0).
INT8_DET = 'ppocrv4_det_int8.onnx'


def int8_detector():
    path = MODEL_ROOT / INT8_DET
    return path if path.is_file() and os.environ.get('CONTRACT_OCR_INT8_DET', '1') != '0' else None
KEY_LINES = {'fast': 0, 'balanced': 0, 'fine': 6}
LABELS = {'v4': 'PP-OCRv4 mobile', 'v5-server': 'PP-OCRv5 server 关键行复核', 'date-vote': '日期三模型复核'}
# Lines below this score were silently dropped before (0.3). Faint handwriting such as a
# signed date often scores low, so keep it and mark it for review instead of losing it.
TEXT_SCORE = 0.15


def model_tag(mode):
    """Model set a mode uses on this installation; part of cache/checkpoint keys."""
    tag = 'v4+v5server' if KEY_LINES.get(mode, 2) and server_available() else 'v4'
    tag += '+int8det' if int8_detector() else ''
    return tag + '+datevote' if mode != 'fast' and date_vote_available() else tag


def server_available():
    return (MODEL_ROOT / FILES['rec_server']).is_file() and (MODEL_ROOT / FILES['keys']).is_file()


def date_vote_available():
    return all((MODEL_ROOT / FILES[name]).is_file() for name in ('rec_server', 'rec_mobile', 'keys'))


def _guard():
    # No telemetry, downloads or cloud inference. Development/test workers prohibit network calls.
    if sys.platform.startswith('linux'):
        sys.path.insert(0, str(Path(__file__).parent))
        import offline_guard  # noqa: F401
    import onnxruntime as ort
    ort.disable_telemetry_events()


def engine_for(mode):
    return 'v4', _build('v4')


def _build(tag):
    global ENGINE
    if tag not in ENGINES:
        _guard()
        from rapidocr_onnxruntime import RapidOCR
        options = dict(intra_op_num_threads=thread_count(), inter_op_num_threads=1, rec_batch_num=6, max_side_len=4200)
        if tag == 'v4' and int8_detector():
            options.update(det_model_path=str(int8_detector()))
        if tag in ('v5-server', 'v5-mobile'):
            rec = 'rec_server' if tag == 'v5-server' else 'rec_mobile'
            options.update(rec_model_path=str(MODEL_ROOT / FILES[rec]), rec_keys_path=str(MODEL_ROOT / FILES['keys']))
        ENGINES[tag] = RapidOCR(**options)
        if ENGINE is None:
            ENGINE = ENGINES[tag]
    return ENGINES[tag]


# Letter/digit confusions inside one Latin/number token, e.g. S0C2 -> SOC2, IS0 -> ISO,
# 18O,000 -> 180,000, Page 1l -> Page 11, 180.000.00 -> 180,000.00. Codes such as V50,
# W70 or B8650 are untouched because their 0 follows a digit.
def fix_confusables(text):
    def token(match):
        value = match.group(0)
        if sum(ch.isalpha() for ch in value) >= 2:
            value = re.sub(r'(?<=[A-Za-z])0(?=[A-Za-z]|$)', 'O', value)
        value = re.sub(r'(?<=\d)[Oo](?=[\d,.]|$)', '0', value)
        value = re.sub(r'(?<=\d)[lI](?=\d|$)', '1', value)
        return value
    text = re.sub(r'[A-Za-z0-9]+', token, str(text))
    text = re.sub(r'(?<![A-Za-z])IS0(?=\s?\d{4,5})', 'ISO', text)  # IS027001 -> ISO27001
    text = re.sub(r'(?<!\d)(\d{1,3})((?:\.\d{3})+)\.(\d{2})(?!\d)', lambda m: m.group(1) + m.group(2).replace('.', ',') + '.' + m.group(3), text)
    text = re.sub(r'(?<=\d)[Oo](?=[,.]\d)|(?<=[\d,])[Oo](?=\d)', '0', text)
    # Full-width punctuation inside numbers: 27001：2022 -> 27001:2022, 180，000 -> 180,000.
    text = re.sub(r'(?<=\d)：(?=\d)', ':', text)
    return re.sub(r'(?<=\d)，(?=\d{3}(?!\d))', ',', text)


def read_crops(tag, crops):
    """Recognition only (no detection) of single-line crops with one model: 'v4', 'v5-mobile' or 'v5-server'."""
    if not crops:
        return []
    results, _ = _build(tag).text_rec(list(crops))
    return [(fix_confusables(text), float(score)) for text, score in results]


def recognize_lines(crops):
    """PP-OCRv5 server recognition of short single-line crops (BGR arrays) -> [(text, score)]."""
    if not crops:
        return []
    engine = _build('v5-server')
    results, _ = engine.text_rec([crop for crop in crops])
    return [(fix_confusables(text), float(score)) for text, score in results]


def initialize_engine():
    engine_for('balanced')


def thread_count():
    # The service splits CPU cores between its OCR worker processes (set before spawn).
    try:
        value = int(os.environ.get('CONTRACT_OCR_THREADS', '0'))
    except ValueError:
        value = 0
    return value if 1 <= value <= 8 else max(1, min(2, (os.cpu_count() or 2) // 2))


def pixmap_array(pixmap):
    """RGB PyMuPDF pixmap -> BGR array without PNG/PPM encoding and decoding."""
    import numpy as np
    channels = pixmap.n
    rows = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.stride)
    array = rows[:, :pixmap.width * channels].reshape(pixmap.height, pixmap.width, channels)
    if channels == 1:
        array = np.repeat(array, 3, axis=2)
    return np.ascontiguousarray(array[:, :, 2::-1])


def recognize_image(content, mode: str):
    import numpy as np
    from PIL import Image, ImageOps
    tag, engine = engine_for(mode)
    started = time.perf_counter()
    if isinstance(content, np.ndarray):
        # Already BGR pixels rendered by PyMuPDF; identical pixels to the old PPM route.
        if content.shape[0] * content.shape[1] > 32_000_000:
            raise ValueError('图片超过3200万像素，请降低分辨率')
        array = content
    else:
        Image.MAX_IMAGE_PIXELS = 32_000_000
        with Image.open(io.BytesIO(content)) as source:
            if source.width * source.height > 32_000_000:
                raise ValueError('图片超过3200万像素，请降低分辨率')
            image = ImageOps.exif_transpose(source).convert('RGB')
            # RapidOCR numpy inputs use BGR; compositing is handled by the browser canvas.
            array = np.asarray(image)[:, :, ::-1].copy()
    longest = {'fast': 1280, 'balanced': 1920, 'fine': 2560}.get(mode, 1920)
    from rapidocr_onnxruntime.ch_ppocr_det.utils import DetPreProcess
    detector = engine.text_det
    detector.get_preprocess = lambda _: DetPreProcess(longest, 'max', detector.mean, detector.std)
    result, _ = engine(array, use_cls=False, text_score=TEXT_SCORE)
    items = []
    for box, text, confidence in result or []:
        if not str(text).strip():
            continue
        xs, ys = [float(p[0]) for p in box], [float(p[1]) for p in box]
        fixed = fix_confusables(text)
        items.append({'text': fixed, **({'ocrRaw': text} if fixed != text else {}), 'score': float(confidence), 'x0': min(xs), 'y0': min(ys), 'x1': max(xs), 'y1': max(ys)})
    # Same visual line = one row, read left to right (PP-OCRv5 detects word-level boxes).
    from layout_quality import group_rows
    rows = group_rows(items)
    items = [item for row in rows for item in row]
    return {'text': '\n'.join(' '.join(item['text'] for item in row) for row in rows), 'lines': items, 'items': items,
            'seconds': round(time.perf_counter() - started, 3), 'engine': 'native', 'ocrModel': LABELS[tag],
            'uncertain': [item for item in items if item['score'] < .8]}
