"""Repair CJK text-layer characters that look right in the PDF but are not normal ideographs.

Word/WPS exports often map 月 日 工 行 用 广 … to Kangxi radicals (U+2F00–U+2FDF) or CJK
compatibility ideographs; search, extraction and comparison then miss them. Same mapping as
the browser parser (js/pdf-parser.js RADICAL_FIX)."""
import unicodedata

RADICAL_FIX = {"⻔": "门", "⻋": "车", "⻅": "见", "⻓": "长", "⻛": "风", "⻢": "马", "⻜": "飞", "⻝": "食", "⻥": "鱼", "⻦": "鸟", "⻩": "黄", "⻰": "龙", "⻆": "角", "⻉": "贝", "⻚": "页", "⻘": "青", "⻨": "麦", "⻬": "齐", "⻮": "齿", "⻳": "龟", "⻊": "足", "⻁": "虎", "⻄": "西", "⻤": "鬼", "⻣": "骨", "⺠": "民", "⺟": "母", "⺮": "竹", "⺶": "羊", "⻑": "長", "⻏": "阝", "⻖": "阝", "⻈": "讠", "⻐": "钅", "⻗": "雨", "⻙": "韦", "⻞": "饣", "⻧": "卤", "⻪": "黾", "⻭": "齿", "⻯": "龙", "⺁": "厂", "⺇": "几", "⺌": "小", "⺍": "小", "⺒": "巳", "⺓": "幺", "⺔": "彐", "⺗": "心", "⺝": "月", "⺞": "歹", "⺡": "氵", "⺢": "水", "⺣": "灬", "⺤": "爫", "⺥": "爫", "⺦": "丬", "⺧": "牛", "⺨": "犭", "⺩": "王", "⺪": "疋", "⺫": "罒", "⺬": "示", "⺭": "礻", "⺯": "糸", "⺰": "纟", "⺲": "罒", "⺳": "网", "⺴": "罒", "⺵": "罒", "⺸": "羊", "⺹": "耂", "⺺": "聿", "⺻": "聿", "⺼": "肉", "⺽": "臼", "⺾": "艹", "⺿": "艹", "⻀": "艹", "⻂": "衤", "⻃": "覀", "⻇": "角", "⻍": "辶", "⻎": "辶", "⻕": "镸", "⼾": "户", "⾢": "邑", "⾣": "酉", "⿓": "龍", "⿔": "龜"}


def fix_cjk(text):
    text = str(text or '')
    if not any(0x2E80 <= ord(ch) <= 0x2FDF or 0xF900 <= ord(ch) <= 0xFAFF for ch in text):
        return text
    out = []
    for ch in text:
        code = ord(ch)
        if ch in RADICAL_FIX:
            out.append(RADICAL_FIX[ch])
        elif 0x2F00 <= code <= 0x2FDF or 0xF900 <= code <= 0xFAFF:
            out.append(unicodedata.normalize('NFKC', ch))
        else:
            out.append(ch)
    return ''.join(out)
