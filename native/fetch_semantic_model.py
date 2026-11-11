"""Build-time download of pinned public weights only. Never run on client documents."""
import hashlib
import os
import json
from pathlib import Path
import urllib.request

REVISION = '75c43b069aac4d136ba6bc1122f995fedcfd2781'
FILES = {
 'model_quantized.onnx': ('onnx/model_quantized.onnx', '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc'),
 'tokenizer.json': ('tokenizer.json', '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26'),
 'README.md': ('README.md', 'cb22054df1a98f7ee9d5b281d023e67c27cc316e1733baf03fc994d95c3048ab')
}
root = Path(__file__).resolve().parent.parent / 'models' / 'semantic_model'
root.mkdir(parents=True, exist_ok=True)
for name, (remote, checksum) in FILES.items():
    url = f"{os.environ.get('HF_ENDPOINT', 'https://huggingface.co').rstrip('/')}/Xenova/bge-small-zh-v1.5/resolve/{REVISION}/{remote}"
    data = urllib.request.urlopen(url, timeout=180).read()
    if hashlib.sha256(data).hexdigest() != checksum: raise RuntimeError('Public model checksum mismatch: ' + name)
    (root/name).write_bytes(data)
(root/'MODEL_SOURCE.json').write_text(json.dumps({'model': 'Xenova/bge-small-zh-v1.5', 'base_model': 'BAAI/bge-small-zh-v1.5', 'revision': REVISION, 'files': FILES}, indent=2))
print('Pinned public semantic weights downloaded and verified; no client data used.')
