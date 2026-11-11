"""Experiment: int8 static (QDQ) quantization of the bundled PP-OCRv4 det/rec models.

Calibration uses synthetic printed contract lines only (no client data). Output models are
evaluated separately for accuracy and speed before the app may use them.
"""
import glob, os, random, sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import rapidocr_onnxruntime
from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static, CalibrationMethod
from onnxruntime.quantization.shape_inference import quant_pre_process

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else 'int8'); OUT.mkdir(parents=True, exist_ok=True)
DET_ONLY = '--det-only' in sys.argv  # app build: the int8 recognizer misreads characters, only detection is used
pkg = Path(rapidocr_onnxruntime.__file__).parent / 'models'
det = next(pkg.glob('*det*.onnx')); rec = next(pkg.glob('*rec*.onnx'))
fonts = [f for f in ['C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/simsun.ttc', 'C:/Windows/Fonts/simkai.ttf'] if os.path.exists(f)] or glob.glob('/usr/share/fonts/**/*CJK*.tt*', recursive=True)[:4]
print('models', det.name, rec.name, 'fonts', fonts)
random.seed(0)
TEXT = ('本工作说明书于2025年11月19日由安永华明会计师事务所根据双方签订的协议编制提供SOC2类型二报告'
        '合同总金额为人民币180,000.00元甲方乙方应当按照ISO 27001:2022开展信息安全管理体系评估服务期间'
        '广州市经济技术开发区科学城科珠路192号联系人电话13800138000统一社会信用代码91440101MA5ABCDE12')

def line_image(rng):
    path = rng.choice(fonts); font = ImageFont.truetype(path, rng.choice([26, 30, 34, 40]), index=rng.choice([0, 2]) if 'CJK' in path else 0)
    start = rng.randrange(0, len(TEXT) - 30); text = TEXT[start:start + rng.randrange(8, 30)]
    w = int(font.getlength(text)) + 30
    img = Image.new('L', (w, 64), rng.choice([225, 236, 250])); ImageDraw.Draw(img).text((15, 10), text, fill=rng.choice([20, 40, 60]), font=font)
    if rng.random() < .5: img = img.filter(ImageFilter.GaussianBlur(rng.choice([.5, .8, 1.0])))
    return img.convert('RGB')

def rec_tensor(img):
    h = 48; w = max(16, int(round(img.width * h / img.height)))
    a = np.asarray(img.resize((w, h)), dtype=np.float32) / 255.0
    return ((a - .5) / .5).transpose(2, 0, 1)[None].astype(np.float32)

def det_tensor(rng):
    page = Image.new('RGB', (1200, 1600), 'white'); d = ImageDraw.Draw(page)
    for y in range(80, 1500, 52):
        path = rng.choice(fonts); font = ImageFont.truetype(path, 30, index=2 if 'CJK' in path else 0); s = rng.randrange(0, len(TEXT) - 40)
        d.text((80, y), TEXT[s:s + 34], fill='black', font=font)
    page = page.resize((736, 960))
    a = np.asarray(page, dtype=np.float32)[:, :, ::-1] / 255.0
    a = (a - np.array([.485, .456, .406], np.float32)) / np.array([.229, .224, .225], np.float32)
    return a.transpose(2, 0, 1)[None].astype(np.float32)

class Reader(CalibrationDataReader):
    def __init__(self, name, items): self.name, self.items = name, iter(items)
    def get_next(self):
        item = next(self.items, None); return None if item is None else {self.name: item}

import onnxruntime as ort
rng = random.Random(0)
jobs = [(det, None)] if DET_ONLY else [(rec, None), (det, None)]
for model, _ in jobs:
    data = [det_tensor(rng) for _ in range(6)] if model == det else [rec_tensor(line_image(rng)) for _ in range(80)]
    import onnx
    from onnx import version_converter
    source = onnx.load(str(model)); opset = next(o.version for o in source.opset_import if o.domain in ('', 'ai.onnx'))
    print(model.name, 'opset', opset)
    if opset < 13:  # per-channel DequantizeLinear (axis) needs opset >= 13
        source = version_converter.convert_version(source, 13)
    upgraded = OUT / (model.stem + '.op13.onnx'); onnx.save(source, str(upgraded))
    pre = OUT / (model.stem + '.pre.onnx'); quant_pre_process(str(upgraded), str(pre), skip_symbolic_shape=True)  # dynamic widths defeat symbolic inference
    upgraded.unlink()
    name = ort.InferenceSession(str(model), providers=['CPUExecutionProvider']).get_inputs()[0].name
    for method in (CalibrationMethod.MinMax,):  # histogram methods fail on variable-width inputs
        target = OUT / f'{model.stem}.int8.{method.name.lower()}.onnx'
        quantize_static(str(pre), str(target), Reader(name, data), quant_format=QuantFormat.QDQ, per_channel=True,
                        activation_type=QuantType.QUInt8, weight_type=QuantType.QInt8, calibrate_method=method,
                        extra_options={'CalibMaxIntermediateOutputs': 7, **({'CalibPercentile': 99.99} if method == CalibrationMethod.Percentile else {})})  # 7 does not divide 80 or 6: an empty final flush errors
        if DET_ONLY:
            final = OUT / 'ppocrv4_det_int8.onnx'; target.replace(final); target = final
        print('wrote', target, target.stat().st_size)
    pre.unlink()
