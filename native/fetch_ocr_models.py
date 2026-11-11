"""Build-time download of public PP-OCRv5 ONNX weights. Never run on client documents.

Run with a separate build environment that has rapidocr==3.8.4 installed. RapidOCR downloads
each file from its official ModelScope repository and checks it against the SHA256 values in
its own model registry; this script then copies the files to models/ocr_models under fixed
names and records their SHA256. The packaged program loads them with rapidocr_onnxruntime and
never downloads anything at run time.
"""
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import shutil
import onnxruntime as ort
from ocr_dictionary import dictionary_from_sessions

import rapidocr
from rapidocr import LangDet, LangRec, ModelType, OCRVersion, RapidOCR

ROOT = Path(__file__).resolve().parent.parent / 'models' / 'ocr_models'
PACKAGE = Path(rapidocr.__file__).resolve().parent


def select(rec_type):
    # Instantiating downloads (and verifies) the requested public models into the package cache.
    RapidOCR(params={
        'Det.lang_type': LangDet.CH, 'Det.model_type': ModelType.MOBILE, 'Det.ocr_version': OCRVersion.PPOCRV5,
        'Rec.lang_type': LangRec.CH, 'Rec.model_type': rec_type, 'Rec.ocr_version': OCRVersion.PPOCRV5,
    })


def find(pattern_parts, suffix):
    candidates = [path for base in (PACKAGE, Path.home() / '.cache' / 'rapidocr') if base.exists() for path in base.rglob('*' + suffix)]
    matches = [path for path in candidates if all(part.lower() in path.name.lower() for part in pattern_parts)]
    if len(matches) != 1:
        listing = '\n'.join(str(path) for path in candidates)
        raise RuntimeError(f'Expected one {pattern_parts} file, found {len(matches)}. Available:\n{listing}')
    return matches[0]


select(ModelType.MOBILE)
select(ModelType.SERVER)
sources = {
    'ppocrv5_det_mobile.onnx': find(['PP-OCRv5', 'det', 'mobile'], '.onnx'),
    'ppocrv5_rec_mobile.onnx': find(['ch_PP-OCRv5', 'rec', 'mobile'], '.onnx'),
    'ppocrv5_rec_server.onnx': find(['ch_PP-OCRv5', 'rec', 'server'], '.onnx'),
}
ROOT.mkdir(parents=True, exist_ok=True)
manifest = {}
for name, source in sources.items():
    shutil.copyfile(source, ROOT / name)
    manifest[name] = {'source': source.name, 'sha256': hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), 'bytes': (ROOT / name).stat().st_size}
# RapidOCR 3.8.4 reads ONNX vocabulary from the model's `character` metadata,
# rather than downloading a separate text file. Preserve its order exactly.
# Upstream: RapidAI/RapidOCR v3.8.4, inference_engine/onnxruntime/main.py.
options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
sessions=[ort.InferenceSession(str(ROOT/name),sess_options=options,providers=['CPUExecutionProvider']) for name in ('ppocrv5_rec_mobile.onnx','ppocrv5_rec_server.onnx')]
keys=dictionary_from_sessions(sessions)
dictionary=ROOT/'ppocrv5_dict.txt';dictionary.write_text('\n'.join(keys)+'\n',encoding='utf-8')
manifest[dictionary.name]={'source':'embedded character metadata in ch_PP-OCRv5_rec_mobile.onnx and ch_PP-OCRv5_rec_server.onnx','sha256':hashlib.sha256(dictionary.read_bytes()).hexdigest(),'bytes':dictionary.stat().st_size}
if len(keys) < 18000:
    raise RuntimeError(f'PP-OCRv5 dictionary unexpectedly small: {len(keys)} entries')
(ROOT / 'MODEL_SOURCE.json').write_text(json.dumps({
    'models': 'PaddleOCR PP-OCRv5 (Apache-2.0), ONNX conversion by RapidAI/RapidOCR',
    'downloadedWith': 'rapidocr ' + version('rapidocr'),
    'dictionaryEntries': len(keys), 'files': manifest}, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(manifest, indent=2))
print('Public PP-OCRv5 weights downloaded and verified by RapidOCR; no client data used.')
