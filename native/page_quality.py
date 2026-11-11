"""Page-level completeness signals; these do not measure character accuracy."""
import io
from PIL import Image, ImageOps, ImageStat

def visual_signal(png):
    with Image.open(io.BytesIO(png)) as image:
        image = ImageOps.grayscale(image)
        image.thumbnail((1000, 1000))
        histogram = image.histogram()
        pixels = max(1, sum(histogram))
        dark = sum(histogram[:200]) / pixels
        # A nearly uniform page is only a blank-page signal, never a guarantee.
        spread = ImageStat.Stat(image).stddev[0]
        return {'darkFraction': round(dark, 6), 'nearBlank': dark < .0002 and spread < 2}

def audit_page(page, lines, signal, retried=False):
    chars = sum(len(''.join(str(line.get('text', '')).split())) for line in lines)
    low = sum(1 for line in lines if line.get('score') is not None and line['score'] < .8)
    state = '有文字'
    issues = []
    if not chars:
        state = '近空白页' if signal['nearBlank'] else '有图像但无识别文字'
        if not signal['nearBlank']: issues.append('页面存在可见内容，但未识别到文字')
    elif low:
        state = '含低分文字'
        issues.append(f'{low}行识别分数低于0.8')
    if chars and signal.get('uncoveredContent'):
        if state == '有文字': state = '存在未覆盖图文'
        issues.append('部分深色图文不在文字框内，可对照原页查看')
    return {'page':page,'characters':chars,'lines':len(lines),'lowScoreLines':low,'state':state,'issues':issues,'retried':retried,**signal}

def coverage_signal(png, lines, width, height):
    from PIL import ImageDraw
    with Image.open(io.BytesIO(png)) as original:
        image = ImageOps.grayscale(original)
        image.thumbnail((1000,1000))
        mask = image.point(lambda value: 255 if value < 160 else 0)
        draw = ImageDraw.Draw(mask)
        sx, sy = mask.width / width, mask.height / height
        for line in lines:
            left=max(0,min(mask.width,line['x0']*sx-2))
            top=max(0,min(mask.height,line['y0']*sy-2))
            right=max(0,min(mask.width,line['x1']*sx+2))
            bottom=max(0,min(mask.height,line['y1']*sy+2))
            if right > left and bottom > top:
                draw.rectangle((left,top,right,bottom),fill=0)
        fraction = sum(mask.histogram()[1:]) / max(1,mask.width*mask.height)
        return {'uncoveredInkFraction':round(fraction,6),'uncoveredContent':fraction > .006}
