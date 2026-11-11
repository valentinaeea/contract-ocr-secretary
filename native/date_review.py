"""Second opinion for dates on scanned pages.

PP-OCRv4 reads handwritten day/month digits wrongly with very high confidence (a handwritten
"19" in "2025年11月19日" came back as "11月1日日" at 0.993), so confidence cannot select
them. Every date found on a scanned page is therefore cropped tightly and read again by
PP-OCRv5 server and PP-OCRv5 mobile; the three readings vote. A majority that differs from
v4 is used and the v4 line is kept as a visible alternative; no majority, or no valid date,
marks the line for review. Nothing is changed silently.
"""
import re

# A date as v4 printed it, tolerating the damage handwriting causes ("1日日", "月 / 日").
DATE_SPAN = re.compile(r'\d{4}\s*年[^年月\n]{0,4}月[^年月日\n]{0,5}日{0,2}')
DATE_VALUE = re.compile(r'(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日')


def parse(text):
    """(year, month, day) of the first well-formed date, or None."""
    match = DATE_VALUE.search(str(text or ''))
    if not match:
        return None
    year, month, day = (int(group) for group in match.groups())
    if not (1900 <= year <= 2100 and 1 <= month <= 12 and 1 <= day <= 31):
        return None
    # "11月1日日": the duplicated 日 means a digit was misread as 日.
    if str(text)[match.end():match.end() + 1] == '日':
        return None
    return year, month, day


def char_weight(ch):
    if ch.isspace():
        return .3
    return .55 if ord(ch) < 0x2E80 else 1.0


def span_box(line, start, end, pad_chars=1.0):
    """Estimate the page box of text[start:end] inside a recognized line box (CJK ≈ 1 em,
    Latin/digits ≈ 0.55 em), padded by about one character on each side."""
    text = str(line['text'])
    weights = [char_weight(ch) for ch in text]
    total = sum(weights) or 1.0
    width = line['x1'] - line['x0']
    unit = width / total
    before = sum(weights[:start])
    inside = sum(weights[start:end])
    height = line['y1'] - line['y0']
    x0 = line['x0'] + (before - pad_chars) * unit
    x1 = line['x0'] + (before + inside + pad_chars) * unit
    return max(line['x0'] - height * .3, x0), line['y0'] - height * .2, min(line['x1'] + height * .3, x1), line['y1'] + height * .2


def vote(v4_text, others):
    """Return (chosen date or None, all parsed readings)."""
    readings = [parse(v4_text)] + [parse(text) for text in others]
    counts = {}
    for value in readings:
        if value:
            counts[value] = counts.get(value, 0) + 1
    best = max(counts.items(), key=lambda item: item[1], default=(None, 0))
    return (best[0] if best[1] >= 2 else None), readings


def format_date(value):
    return f'{value[0]}年{value[1]}月{value[2]}日'


def apply(line, start, end, others):
    """Update one OCR line for the date at text[start:end]; returns 'kept', 'corrected' or 'review'."""
    text = str(line['text'])
    span = text[start:end]
    chosen, readings = vote(span, others)
    if chosen and readings[0] == chosen:
        return 'kept'
    alternatives = list(line.get('alternatives') or [])
    if chosen:
        line['text'] = text[:start] + format_date(chosen) + text[end:]
        line['alternatives'] = [text] + [item for item in alternatives if item != text]
        line['dateVote'] = 'corrected'
        return 'corrected'
    for value in readings[1:]:
        if value and format_date(value) not in alternatives and format_date(value) != span:
            alternatives.append(format_date(value))
    # Marked yellow even without another reading: v4 printed an impossible date.
    line['alternatives'] = alternatives or ['日期需核对']
    line['dateVote'] = 'review'
    return 'review'
