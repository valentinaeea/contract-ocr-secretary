"""Conservative reading order and small-text crops. Never remove header/footer text."""
import re

def group_rows(lines):
    """Rows by vertical centre, so boxes on one visual line whose tops differ by a few pixels
    stay together (PP-OCRv5 detects word-level boxes); each row is ordered left to right."""
    rows=[]
    for line in sorted(lines,key=lambda line:(line['y0']+line['y1'])/2):
        height=max(1e-6,line['y1']-line['y0']);centre=(line['y0']+line['y1'])/2
        if rows:
            row=rows[-1]
            row_centre=sum((item['y0']+item['y1'])/2 for item in row)/len(row)
            row_height=sorted(item['y1']-item['y0'] for item in row)[len(row)//2]
            if abs(centre-row_centre)<.5*min(height,max(1e-6,row_height)):
                row.append(line);continue
        rows.append([line])
    return [sorted(row,key=lambda line:line['x0']) for row in rows]

def phrases(row):
    """Join boxes separated by ordinary word spacing; wide gaps stay separate (table cells)."""
    groups=[]
    for line in row:
        height=max(1e-6,line['y1']-line['y0'])
        if groups and line['x0']-groups[-1]['x1']<1.2*max(height,groups[-1]['height']):
            group=groups[-1];group['lines'].append(line);group['x1']=max(group['x1'],line['x1'])
            group['y0']=min(group['y0'],line['y0']);group['y1']=max(group['y1'],line['y1'])
        else:groups.append({'lines':[line],'x0':line['x0'],'x1':line['x1'],'y0':line['y0'],'y1':line['y1'],'height':height})
    for group in groups:group['text']=' '.join(line['text'] for line in group['lines'])
    return groups

def arrange(lines, width, height):
    rows=[phrases(row) for row in group_rows(lines)]
    paired=sum(len(row)>1 for row in rows)
    # Repeated aligned cells are kept in row order, never treated as prose columns.
    table=paired>=3 and paired>=len(rows)*.4
    flat=[(index,group) for index,row in enumerate(rows) for group in row]
    left=[item for item in flat if item[1]['x1']<width*.49]
    right=[item for item in flat if item[1]['x0']>width*.51]
    spanning=[item for item in flat if item not in left and item not in right]
    columns=not table and len(left)>=3 and len(right)>=3 and len(spanning)<=2
    if columns:
        top=min(group['y0'] for _,group in left+right)
        above=[item for item in spanning if item[1]['y0']<top]
        below=[item for item in spanning if item not in above]
        if any(top<=group['y0']<max(g['y1'] for _,g in left+right) for _,group in below): columns=False
    if columns:
        sequence=above+left+right+below
        text='\n'.join(group['text'] for _,group in sequence)
        ordered=[line for _,group in sequence for line in group['lines']]
    else:
        text='\n'.join(('\t' if table else ' ').join(group['text'] for group in row) for row in rows)
        ordered=[line for row in rows for group in row for line in group['lines']]
    for line in ordered:
        line['region']='页眉' if line['y1']<height*.07 else '页脚' if line['y0']>height*.93 else '正文'
    return ordered,text,{'readingOrder':'分栏阅读' if columns else '按行阅读','alignedRows':paired if table else 0,'headerFooterLines':sum(line['region']!='正文' for line in ordered)}

# Dates, amounts and signature blocks are where handwriting and misreads matter most.
KEY_CONTENT=re.compile(r'(?:\d|[〇零一二三四五六七八九十]|_{2,}|\s)\s*年\s*\S{0,4}\s*月|月\s*\S{0,4}\s*日|\d{4}\s*[./-]\s*\d{1,2}\s*[./-]\s*\d{1,2}|日期|签署|签订|签字|盖章|[¥￥]|人民币|金额|万元|\d{1,3}(?:[,.]\d{3})+|[A-Za-z]+[0O]?\d+|期间|至\s*\d')

def key_content(text):
    return bool(KEY_CONTENT.search(str(text or '')))

def small_text_regions(lines,width,height,limit=4):
    regions=[]
    for line in sorted(lines,key=lambda line:line['y0']):
        score=line.get('score')
        weak=line['y1']-line['y0']<9 or (score is not None and score<.8)
        # Recognized dates/amounts get the high-accuracy pass unless the reading is near-certain.
        # Dates have their own three-model vote and amount misreads are fixed in text, so the
        # high-resolution re-read is for small or low-confidence text only (faster pages).
        key=False
        if not (weak or key): continue
        top=max(0,line['y0']-18);bottom=min(height,line['y1']+18)
        if regions and top<=regions[-1][3] and max(bottom,regions[-1][3])-regions[-1][1]<=160:
            regions[-1]=(0,regions[-1][1],width,max(bottom,regions[-1][3]),regions[-1][4] or key)
        else: regions.append((0,top,width,bottom,key))
    # Within the per-page limit, regions holding dates/amounts go first; output stays top-down.
    chosen=sorted(sorted(regions,key=lambda region:(not region[4],region[1]))[:limit],key=lambda region:region[1])
    return [region[:4] for region in chosen],len(regions)>limit

def supplement(lines, extra):
    """Merge a high-resolution re-read into the page without duplicating text.

    The re-read often splits a row differently ("附录二一" + "般条款与条件" vs one box). A
    candidate is only: skipped when its text is already covered by the boxes it overlaps;
    kept as an alternative reading when it covers the same box with different text; added
    as a new line only when nothing was recognized there. Partial overlaps with different
    segmentation are ignored instead of stacking a second copy on the page."""
    added=0; conflicts=0
    norm=lambda text:re.sub(r'\s+','',str(text))
    area=lambda box:max(1e-6,(box['x1']-box['x0'])*(box['y1']-box['y0']))
    for line in extra:
        text=norm(line['text'])
        if not text: continue
        overlaps=[]
        for old in lines:
            inter=max(0,min(old['x1'],line['x1'])-max(old['x0'],line['x0']))*max(0,min(old['y1'],line['y1'])-max(old['y0'],line['y0']))
            if inter>0: overlaps.append((old,inter/area(line),inter/area(old)))
        covered=sum(own for _,own,_ in overlaps)
        if not overlaps or covered<.15:
            lines.append(line);added+=1;continue
        joined=''.join(norm(old['text']) for old,_,_ in sorted(overlaps,key=lambda item:item[0]['x0']))
        if text in joined: continue  # a fragment of text already on the page
        # Longer reading over the same boxes (e.g. USD 100 vs USD 1000) is a real conflict;
        # only a candidate reaching beyond the recognized boxes is a segmentation difference.
        if joined in text and covered<.85: continue
        old,own,theirs=max(overlaps,key=lambda item:min(item[1],item[2]))
        if min(own,theirs)>=.6 and line['text'] not in old.setdefault('alternatives',[]):
            old['alternatives'].append(line['text']);conflicts+=1
    return added,conflicts
