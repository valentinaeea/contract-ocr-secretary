"""Offline pretrained Chinese embeddings for candidate retrieval, not legal/audit conclusions."""
from pathlib import Path
import os
import re
import sys
import threading

MODEL_NAME = 'Xenova/bge-small-zh-v1.5 (pretrained, int8)'
ROOT = Path(os.environ.get('CONTRACT_OCR_SEMANTIC_MODEL_DIR', str(Path(sys._MEIPASS) / 'semantic_model' if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent.parent / 'models' / 'semantic_model')))
LOCK = threading.RLock()
SESSION = None
TOKENIZER = None
PROTOTYPES = None
BANK = [
 ('SEM_IPO_RELATED', 'IPO相关背景 / 上市支持（语义候选）', '企业首次公开发行股票并申请交易所挂牌上市，上市申报、保荐人尽职调查和信息系统审核支持。'),
 ('SEM_SOC1_RELATED', '服务机构财务报告控制鉴证（SOC 1相关语义候选）', '对服务机构与用户财务报告相关的内部控制开展鉴证，在一个期间内测试控制设计和运行有效性，提供SOC1类型二报告。'),
 ('SEM_SOC2_RELATED', '可信服务控制鉴证（SOC 2相关语义候选）', '鉴证服务机构系统在安全性、可用性、保密性及隐私方面的控制设计和运行有效性，提供SOC2类型二报告。'),
 ('SEM_DATA_REVIEW', '数据核查 / 数据质量与业财核对（语义候选）', '核对业务订单、交易流水、平台账单和财务凭证，检查数据真实性、准确性、完整性和业财一致性。'),
 ('SEM_ISO_PREPARATION', '管理体系评估 / 认证准备（语义候选）', '协助企业准备信息安全及隐私管理体系认证，提供标准培训、差距分析、整改辅导和认证审核支持。'),
 ('OTHER', '其他通用条款', '合同约定保密义务、付款期限、违约赔偿、争议解决以及资料不得用于其他目的，这些不是项目核心服务。')
]


def encode(texts):
    import numpy as np
    tokens = TOKENIZER.encode_batch(texts)
    values = {'input_ids': [t.ids for t in tokens], 'attention_mask': [t.attention_mask for t in tokens], 'token_type_ids': [t.type_ids for t in tokens]}
    output = SESSION.run(None, {entry.name: np.asarray(values[entry.name], dtype=np.int64) for entry in SESSION.get_inputs()})[0]
    vectors = output[:, 0, :] if output.ndim == 3 else output
    return vectors / np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-12)


def initialize():
    global SESSION, TOKENIZER, PROTOTYPES
    if SESSION is not None: return
    import onnxruntime as ort
    ort.disable_telemetry_events()
    os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
    from tokenizers import Tokenizer
    options = ort.SessionOptions(); options.intra_op_num_threads = 2; options.inter_op_num_threads = 1
    tokenizer = Tokenizer.from_file(str(ROOT / 'tokenizer.json'))
    tokenizer.enable_truncation(max_length=256); tokenizer.enable_padding()
    session = ort.InferenceSession(str(ROOT / 'model_quantized.onnx'), options, providers=['CPUExecutionProvider'])
    SESSION, TOKENIZER = session, tokenizer
    PROTOTYPES = encode([row[2] for row in BANK])


def lower_priority():
    # Semantic analysis is background work: OCR of the next file gets the CPU first.
    try:
        if sys.platform == 'win32':
            import ctypes
            from ctypes import wintypes
            kernel = ctypes.WinDLL('kernel32')
            kernel.GetCurrentProcess.restype = wintypes.HANDLE
            kernel.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
            kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x00004000)  # BELOW_NORMAL_PRIORITY_CLASS
        else:
            os.nice(5)
    except Exception:
        pass


def initialize_worker():
    if sys.platform.startswith('linux'):
        sys.path.insert(0, str(Path(__file__).parent))
        import offline_guard
    lower_priority()
    initialize()


def classify(text):
    if not (ROOT / 'model_quantized.onnx').exists():
        return {'semanticTags': [], 'semanticModel': None, 'semanticNote': '本地语义模型未安装，仅提供同义表达与组合规则候选。'}
    source = str(text or '')
    excerpts = []
    for match in re.finditer(r'(?:[^\n。！？；]|\n(?!\s*\n))+[。！？；]?', source):
        # Overlap long passages rather than silently discarding later clauses.
        for offset in range(0, len(match[0]), 160):
            excerpt = match[0][offset:offset+220].strip()
            compact = re.sub(r'\s+', '', excerpt)
            if len(compact) < 12: continue
            if re.search(r'不涉及|不包括|不提供|不构成|不以|不得将|不会提供|不保证', compact): continue
            excerpts.append(excerpt)
    candidates = {}
    with LOCK:
        initialize()
        import numpy as np
        for start in range(0, len(excerpts), 12):
            batch = excerpts[start:start+12]
            scores = encode([re.sub(r'\s+', '', item) for item in batch]) @ PROTOTYPES.T
            for excerpt, similarities in zip(batch, scores):
                ranking = np.argsort(-similarities)
                best, second = int(ranking[0]), int(ranking[1])
                similarity = float(similarities[best])
                if BANK[best][0] == 'OTHER' or similarity < .62 or similarity - float(similarities[second]) < .04: continue
                code, label, _ = BANK[best]
                compact = re.sub(r'\s+', '', excerpt).lower()
                families = re.findall(r's[o0]c([12])', compact)
                if code == 'SEM_SOC1_RELATED' and '2' in families and '1' not in families: continue
                if code == 'SEM_SOC2_RELATED' and '1' in families and '2' not in families: continue
                candidate = candidates.setdefault(code, {'code': code, 'label': label, 'status': '预训练语义相似候选，必须复核；不自动确定报告类型', 'reason': '依据业务描述相似性召回；相似度不是准确率或审计结论。', 'evidence': [], 'similarity': similarity})
                if len(candidate['evidence']) < 3 and excerpt not in candidate['evidence']: candidate['evidence'].append(excerpt)
                candidate['similarity'] = max(candidate['similarity'], similarity)
    return {'semanticTags': list(candidates.values()), 'semanticModel': MODEL_NAME, 'semanticNote': '本地预训练语义匹配，未使用客户合同微调；相似度不是准确率，类型与范围请核对原文。'}
