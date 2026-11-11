"""Whole-document jobs run in OCR worker processes independently of the browser tab."""
from pathlib import Path
import json
import os
import re
import unicodedata
import time


def check_cancelled(progress_path):
    if Path(progress_path).with_suffix('.cancel').exists():
        raise RuntimeError('TASK_CANCELLED')


def progress(path, current, total, phase):
    check_cancelled(path)
    destination = Path(path)
    payload = json.dumps({'current': current, 'total': total, 'phase': phase}, ensure_ascii=False)
    # This is a disposable UI snapshot, not the persisted OCR result. Windows
    # readers can hold a file open without delete sharing, so replacing it fails.
    # Overwrite in place instead; the HTTP reader already ignores incomplete JSON.
    for attempt in range(3):
        try:
            destination.write_text(payload, encoding='utf-8')
            return True
        except OSError:
            check_cancelled(path)
            if attempt < 2:
                time.sleep(.02 * (attempt + 1))
    # Progress is best effort: a locked snapshot must never fail document OCR.
    return False



def recognize_document(input_path, filename, mode, progress_path, upload_category='other'):
    import pymupdf as fitz
    from engine import recognize_image
    check_cancelled(progress_path)
    data = Path(input_path).read_bytes()
    started = time.perf_counter()
    notes = []
    from recovery import peak_memory_mb
    from layout_quality import arrange, small_text_regions, supplement
    from page_quality import visual_signal, audit_page, coverage_signal
    page_audit = []
    if not filename.lower().endswith('.pdf'):
        progress(progress_path, 0, 1, '本机OCR识别图片中')
        check_cancelled(progress_path)
        result = recognize_image(data, mode)
        check_cancelled(progress_path)
        if not result['text'].strip():
            raise ValueError('图片中没有识别到文字')
        if result['uncertain']:
            notes.append({'page': 1, 'message': f"{len(result['uncertain'])}行识别分数较低，请核对原件"})
        progress(progress_path, 1, 1, '图片识别完成')
        check_cancelled(progress_path)
        from PIL import Image, ImageOps
        import io
        with Image.open(io.BytesIO(data)) as image:
            image = ImageOps.exif_transpose(image)
            layout = [{'page': 1, 'width': image.width, 'height': image.height, 'lines': result['lines']}]
        page_audit.append(audit_page(1, result['lines'], visual_signal(data)))
        page_audit[0]['seconds']=round(time.perf_counter()-started,3)
        page_audit[0]['ocrModels']=[result['ocrModel']] if result.get('ocrModel') else []
        return {'ocrModel':result.get('ocrModel'),'failedPages':[],'resumedPages':0,'peakWorkerMemoryMB':peak_memory_mb(),'pageAudit': page_audit, 'layoutPages': layout, 'rawText': result['text'], 'pageCount': 1, 'ocrUsed': True, 'reviewNotes': notes, 'engine': 'native', 'workerPid': os.getpid(), 'seconds': time.perf_counter() - started, 'semanticTags':[], 'analysisStatus':'queued'}
    from recovery import PageCheckpoint,peak_memory_mb
    checkpoint=PageCheckpoint(progress_path,data,mode)
    outcomes=[]
    with fitz.open(stream=data, filetype='pdf') as document:
        if document.needs_pass:
            raise ValueError('PDF已加密，请先提供可打开的副本')
        for page_no, page in enumerate(document, 1):
            progress(progress_path, page_no - 1, len(document), f'本机处理第 {page_no}/{len(document)} 页')
            outcomes.append(process_page(page,page_no,len(document),mode,progress_path,checkpoint))
            progress(progress_path,page_no,len(document),f'已处理第 {page_no}/{len(document)} 页')
    return assemble_pdf(outcomes,progress_path,started,peak_memory_mb(),[os.getpid()])


def process_page(page,page_no,total,mode,progress_path,checkpoint,report=True):
    """One PDF page with checkpoint reuse. Page failures are recorded, cancellation propagates."""
    cached=checkpoint.load(page_no)
    page_started=time.perf_counter()
    failed=False
    try:
        if cached:result=cached
        elif report:result=recognize_pdf_page(page,page_no,total,mode,progress_path)
        else:result=recognize_pdf_page(page,page_no,total,mode,progress_path,report=False)
        if not cached:
            result['audit']['seconds']=round(time.perf_counter()-page_started,3)
            try:checkpoint.save(page_no,result)
            except OSError:result['audit']['checkpointSaved']=False
        result['audit']['fromCheckpoint']=bool(cached)
    except Exception as error:
        check_cancelled(progress_path)
        failed=True
        result={'text':'','layout':{'page':page_no,'width':page.rect.width,'height':page.rect.height,'lines':[]},'audit':{'page':page_no,'characters':0,'lines':0,'lowScoreLines':None,'state':'本页处理失败','issues':[type(error).__name__+': '+str(error)[:160]],'seconds':round(time.perf_counter()-page_started,3),'nearBlank':False},'notes':[{'page':page_no,'message':'本页处理失败，可仅重试失败页'}],'ocrUsed':False}
    return {'page':page_no,'result':result,'resumed':bool(cached),'failed':failed}


def assemble_pdf(outcomes,progress_path,started,peak_memory,worker_pids):
    failures=[];resumed_pages=0;pages=[];layout_pages=[];page_audit=[];notes=[];used_ocr=False
    for outcome in sorted(outcomes,key=lambda item:item['page']):
        result=outcome['result']
        if outcome['failed']:failures.append(outcome['page'])
        if outcome['resumed']:resumed_pages+=1
        offset=sum(len(text)+2 for text in pages)
        result['layout'].update(rawStart=offset,rawEnd=offset+len(result['text']))
        pages.append(result['text']);layout_pages.append(result['layout']);page_audit.append(result['audit'])
        notes.extend(result['notes']);used_ocr=used_ocr or result['ocrUsed']
    full_text = '\n\n'.join(pages)
    if not failures and not full_text.strip() and not all(row['nearBlank'] for row in page_audit):
        raise ValueError('整份文件未识别到文字；存在可见内容的页码：' + '、'.join(str(row['page']) for row in page_audit if not row['nearBlank']))
    check_cancelled(progress_path)
    pids=[pid for pid in dict.fromkeys(worker_pids) if pid]
    models=sorted({model for row in page_audit for model in (row.get('ocrModels') or [])})
    stages={}
    for row in page_audit:
        for key,value in (row.get('stageSeconds') or {}).items():stages[key]=round(stages.get(key,0)+value,2)
    return {'stageSeconds':stages or None,'ocrModel':' + '.join(models) if models else None,'failedPages':failures,'resumedPages':resumed_pages,'peakWorkerMemoryMB':peak_memory,'pageAudit': page_audit, 'layoutPages': layout_pages, 'rawText': full_text, 'pageCount': len(pages), 'ocrUsed': used_ocr, 'reviewNotes': notes, 'engine': 'native', 'workerPid': pids[0] if pids else os.getpid(), 'workerPids': pids, 'ocrThreads': int(os.environ.get('CONTRACT_OCR_THREADS') or 0) or None, 'seconds': time.perf_counter() - started, 'semanticTags':[], 'analysisStatus':'queued'}


def recognize_page_task(input_path,page_no,mode,progress_path,digest):
    """Runs in an OCR worker process: exactly one page, checkpointed, no shared progress writes."""
    import pymupdf as fitz
    from recovery import PageCheckpoint,peak_memory_mb
    check_cancelled(progress_path)
    checkpoint=PageCheckpoint(progress_path,None,mode,digest=digest)
    with fitz.open(input_path,filetype='pdf') as document:
        outcome=process_page(document[page_no-1],page_no,len(document),mode,progress_path,checkpoint,report=False)
    outcome.update(pid=os.getpid(),peakMemoryMB=peak_memory_mb())
    return outcome


def recognize_document_parallel(submit,input_path,filename,mode,progress_path,upload_category='other',window=2):
    """Coordinator (service thread): spread one PDF's pages over all OCR worker processes.

    At most `window` pages of this document are in flight, so two documents still share
    the workers fairly. Result, checkpoints and cancellation match recognize_document."""
    import concurrent.futures
    import hashlib
    import pymupdf as fitz
    check_cancelled(progress_path)
    started=time.perf_counter()
    data=Path(input_path).read_bytes()
    digest=hashlib.sha256(data).hexdigest()
    with fitz.open(stream=data,filetype='pdf') as document:
        if document.needs_pass:
            raise ValueError('PDF已加密，请先提供可打开的副本')
        total=len(document)
    del data
    progress(progress_path,0,total,f'本机多进程处理，共 {total} 页')
    outcomes=[];pending={};next_page=1
    try:
        while next_page<=total or pending:
            while next_page<=total and len(pending)<max(1,window):
                check_cancelled(progress_path)
                pending[submit(recognize_page_task,str(input_path),next_page,mode,str(progress_path),digest)]=next_page
                next_page+=1
            finished,_=concurrent.futures.wait(list(pending),timeout=.5,return_when=concurrent.futures.FIRST_COMPLETED)
            check_cancelled(progress_path)
            for future in finished:
                pending.pop(future)
                outcomes.append(future.result())
                progress(progress_path,len(outcomes),total,f'已处理 {len(outcomes)}/{total} 页')
    finally:
        for future in pending:future.cancel()
    peaks=[item.get('peakMemoryMB') for item in outcomes if item.get('peakMemoryMB')]
    result=assemble_pdf(outcomes,progress_path,started,max(peaks) if peaks else None,[item.get('pid') for item in outcomes])
    result['ocrWorkers']=window
    return result


DATE_REVIEW_LIMIT=8


def date_review(page,lines,mode,progress_path,models):
    """均衡/精细: every date on an OCR'd page is re-read from a tight crop by PP-OCRv5 server and
    mobile and decided by majority with the v4 reading (see date_review.py). Short crops cost
    about 1-2 s each, and most pages have no dates."""
    from engine import date_vote_available,read_crops,pixmap_array,LABELS
    import date_review as dates
    if mode=='fast' or not date_vote_available():return {}
    import pymupdf as fitz
    jobs=[]
    for line in lines:
        if line.get('score') is None:continue  # PDF text layer: exact, nothing to vote on
        for match in dates.DATE_SPAN.finditer(str(line.get('text',''))):
            jobs.append((line,match.start(),match.end()))
    jobs=jobs[:DATE_REVIEW_LIMIT]
    if not jobs:return {}
    crops=[]
    for line,start,end in jobs:
        check_cancelled(progress_path)
        rect=fitz.Rect(*dates.span_box(line,start,end))&page.rect
        scale=min(300/72,1600/max(1,rect.width))
        crops.append(pixmap_array(page.get_pixmap(matrix=fitz.Matrix(scale,scale),clip=rect,alpha=False)))
    # Fast PP-OCRv5 mobile first (~0.2 s); the slow server model (~2.4 s per date) only breaks
    # ties where v4 and mobile disagree, e.g. a handwritten "19" that v4 read as "1日日".
    mobile=read_crops('v5-mobile',crops)
    disputed=[i for i,(line,start,end) in enumerate(jobs) if dates.parse(str(line['text'])[start:end])!=dates.parse(mobile[i][0]) or not dates.parse(mobile[i][0])]
    server=[('',0.0)]*len(jobs)
    for i,reading in zip(disputed,read_crops('v5-server',[crops[i] for i in disputed])):server[i]=reading
    check_cancelled(progress_path)
    models.add(LABELS['date-vote'])
    counts={'kept':0,'corrected':0,'review':0}
    # Apply right-to-left per line so earlier spans keep their offsets.
    for index in sorted(range(len(jobs)),key=lambda i:(id(jobs[i][0]),-jobs[i][1])):
        line,start,end=jobs[index]
        counts[dates.apply(line,start,end,[mobile[index][0]]+([server[index][0]] if index in disputed else []))]+=1
    return counts


def key_line_review(page,lines,mode,progress_path,models):
    """Re-read a few short key lines (dates, amounts, codes such as SOC2/ISO, low confidence)
    with the PP-OCRv5 server recognizer: up to 2 per page in 均衡, 6 in 精细, none in 快速.
    It costs ~2 s per line on CPU, so it never runs on whole pages. A clearly confident
    different reading is used; when letters/digits differ the v4 reading stays visible as an
    alternative (yellow mark), so a changed number is never hidden."""
    from engine import KEY_LINES,server_available,recognize_lines,pixmap_array,LABELS
    from layout_quality import key_content
    limit=KEY_LINES.get(mode,0)
    if not limit or not server_available():return 0,0
    import pymupdf as fitz
    pool=[line for line in lines if line.get('score') is not None and str(line.get('text','')).strip() and (line['score']<.8 or (key_content(line['text']) and line['score']<.95))]
    chosen=sorted(pool,key=lambda line:(not key_content(line['text']),line['score']))[:limit]
    if not chosen:return 0,0
    crops=[]
    for line in chosen:
        check_cancelled(progress_path)
        height=max(4,line['y1']-line['y0'])
        rect=fitz.Rect(line['x0']-height*.3,line['y0']-height*.2,line['x1']+height*.3,line['y1']+height*.2)&page.rect
        scale=min(300/72,2400/max(1,rect.width))
        crops.append(pixmap_array(page.get_pixmap(matrix=fitz.Matrix(scale,scale),clip=rect,alpha=False)))
    readings=recognize_lines(crops)
    check_cancelled(progress_path)
    models.add(LABELS['v5-server'])
    adopted=0
    plain=lambda text:re.sub(r'\s+','',unicodedata.normalize('NFKC',str(text)))
    for line,(text,score) in zip(chosen,readings):
        if not text.strip() or plain(text)==plain(line['text']):continue
        if score>=.9 or score>=line['score']+.05:
            # Only letter/digit changes are worth a visible alternative; width of ：/, is not.
            if re.sub(r'[^0-9A-Za-z\u4e00-\u9fff]','',plain(text))!=re.sub(r'[^0-9A-Za-z\u4e00-\u9fff]','',plain(line['text'])):
                line['alternatives']=[line['text']]+[item for item in line.get('alternatives',[]) if item!=text]
            line['text']=text;line['score']=score;line['serverReading']=True;adopted+=1
        elif text not in line.get('alternatives',[]):
            line['alternatives']=line.get('alternatives',[])+[text]
    return len(readings),adopted


def recognize_pdf_page(page,page_no,total,mode,progress_path,report=True):
    import pymupdf as fitz
    from engine import recognize_image,pixmap_array
    from layout_quality import arrange,small_text_regions,supplement
    from page_quality import visual_signal,audit_page,coverage_signal
    if not report:
        # Pages of one document run in parallel; only the coordinator reports progress.
        def progress(path,*_):check_cancelled(path)
    else:
        progress=globals()['progress']
    page_clock=time.perf_counter()
    notes=[];used_ocr=False;models=set()
    from text_normalize import fix_cjk
    text = fix_cjk(page.get_text('text'))
    scan = len(re.sub(r'\W+', '', text)) < 10
    dpi = {'fast': 160, 'balanced': 220, 'fine': 300}.get(mode, 220)
    scale = min(dpi / 72, 4200 / max(page.rect.width, page.rect.height))
    if scan:
        regions = [page.rect]
        lines = []
    else:
        from text_normalize import fix_cjk
        lines = [{'text': fix_cjk(''.join(span['text'] for span in line['spans'])), 'x0': line['bbox'][0], 'y0': line['bbox'][1], 'x1': line['bbox'][2], 'y1': line['bbox'][3]} for block in page.get_text('dict',flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)['blocks'] if block.get('type') == 0 for line in block.get('lines', []) if any(span['text'].strip() for span in line['spans'])]
        regions = []
        for image in page.get_image_info():
            rectangle = fitz.Rect(image['bbox']) & page.rect
            if rectangle.width >= 24 and rectangle.height >= 10 and rectangle.get_area() >= 900:
                # Skip duplicate image rectangles; never cap a page silently.
                if not any(abs(rectangle.x0-r.x0) < 1 and abs(rectangle.y0-r.y0) < 1 and abs(rectangle.x1-r.x1) < 1 and abs(rectangle.y1-r.y1) < 1 for r in regions):
                    regions.append(rectangle)
    audit_png = page.get_pixmap(matrix=fitz.Matrix(1,1), alpha=False).tobytes('png')
    signal = visual_signal(audit_png)
    retried = False
    layer_lines = list(lines)
    uncertain = 0
    for rectangle in regions:
        check_cancelled(progress_path)
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), clip=rectangle, alpha=False)
        result = recognize_image(pixmap_array(pixmap), mode)
        models.add(result.get('ocrModel'))
        check_cancelled(progress_path)
        if scan and not result['text'].strip() and not signal['nearBlank'] and mode != 'fine':
            progress(progress_path, page_no - 1, total, f'第 {page_no} 页无文字，自动精细重试')
            retry_scale = min(300 / 72, 4200 / max(page.rect.width, page.rect.height))
            retry_pixmap = page.get_pixmap(matrix=fitz.Matrix(retry_scale, retry_scale), clip=rectangle, alpha=False)
            result = recognize_image(pixmap_array(retry_pixmap), 'fine')
            models.add(result.get('ocrModel'))
            scale = retry_scale
            retried = True
            check_cancelled(progress_path)
        used_ocr = True
        uncertain += len(result['uncertain'])
        for line in result['lines']:
            normalized = re.sub(r'\s+', '', line['text'])
            y = rectangle.y0 + line['y0'] / scale
            x = rectangle.x0 + line['x0'] / scale
            duplicate = any(normalized and normalized in re.sub(r'\s+', '', layer['text']) and abs(layer['y0'] - y) < 30 for layer in layer_lines)
            if not duplicate:
                lines.append({'text': line['text'], 'x0': x, 'y0': y, 'score': line.get('score'), 'x1': rectangle.x0 + line['x1'] / scale, 'y1': rectangle.y0 + line['y1'] / scale})
    stage={'ocr':round(time.perf_counter()-page_clock,3)}
    clock=time.perf_counter()
    patch_count=0;added_lines=0;alternative_lines=0;patch_limited=False
    if scan and lines:
        patches,patch_limited=small_text_regions(lines,page.rect.width,page.rect.height,{'fast':0,'balanced':2,'fine':4}.get(mode,2))
        for coords in patches:
            check_cancelled(progress_path)
            progress(progress_path,page_no-1,total,f'第 {page_no} 页小字局部识别')
            rect=fitz.Rect(coords)
            patch_scale=min(300/72,4200/max(rect.width,rect.height))
            image=page.get_pixmap(matrix=fitz.Matrix(patch_scale,patch_scale),clip=rect,alpha=False)
            extra=recognize_image(pixmap_array(image),'fine')
            models.add(extra.get('ocrModel'))
            check_cancelled(progress_path)
            candidates=[{**line,'x0':rect.x0+line['x0']/patch_scale,'x1':rect.x0+line['x1']/patch_scale,'y0':rect.y0+line['y0']/patch_scale,'y1':rect.y0+line['y1']/patch_scale} for line in extra['lines']]
            added,conflicts=supplement(lines,candidates)
            added_lines+=added;alternative_lines+=conflicts;patch_count+=1
    stage['patches']=round(time.perf_counter()-clock,3);clock=time.perf_counter()
    server_checked,server_adopted=key_line_review(page,lines,mode,progress_path,models)
    stage['keyLines']=round(time.perf_counter()-clock,3);clock=time.perf_counter()
    date_votes=date_review(page,lines,mode,progress_path,models)
    stage['dates']=round(time.perf_counter()-clock,3)
    lines,page_text,structure=arrange(lines,page.rect.width,page.rect.height)
    structure.update(smallTextCrops=patch_count,supplementedLines=added_lines,alternativeLines=alternative_lines,cropLimitReached=patch_limited,serverCheckedLines=server_checked,serverAdoptedLines=server_adopted,datesChecked=sum(date_votes.values()),datesCorrected=date_votes.get('corrected',0),datesToReview=date_votes.get('review',0))
    layout={'page':page_no,'width':page.rect.width,'height':page.rect.height,'lines':lines,**structure}
    signal.update(coverage_signal(audit_png, lines, page.rect.width, page.rect.height))
    audit={**audit_page(page_no, lines, signal, retried), **structure, 'ocrModels':sorted(model for model in models if model)}
    audit['stageSeconds']=stage
    if uncertain:
        notes.append({'page': page_no, 'message': f'{uncertain}行识别分数较低，请核对原件'})
    if not page_text.strip():
        notes.append({'page': page_no, 'message': '未识别到文字，请确认是空白页还是遗漏'})
    return {'text':page_text,'layout':layout,'audit':audit,'notes':notes,'ocrUsed':used_ocr}
