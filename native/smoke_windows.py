"""CI-only packaged-executable smoke test using a synthetic document, never client data."""
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.request


def main():
    from PIL import Image, ImageDraw, ImageFont
    import pymupdf as fitz
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory() as temporary:
        env = {**os.environ, 'CONTRACT_OCR_DATA_DIR': str(Path(temporary) / 'data'), 'CONTRACT_OCR_DIAGNOSTICS': '1', 'CONTRACT_OCR_WORKERS':'2'}
        process = subprocess.Popen([str(executable), '--no-browser'], env=env)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        origin = 'http://127.0.0.1:18765'
        def request(path, data=None, headers=None):
            try:
                response = opener.open(urllib.request.Request(origin + path, data=data, headers=headers or {}), timeout=180)
            except urllib.error.HTTPError as error:
                print('Local API error:', error.read().decode('utf-8', errors='replace'))
                raise
            return response.read()
        try:
            for _ in range(120):
                try:
                    health = json.loads(request('/api/health'))
                    if health['application'] == 'ContractOCR': break
                except OSError:
                    pass
                if process.poll() is not None: raise RuntimeError('Packaged executable exited during startup')
                time.sleep(.5)
            else: raise RuntimeError('Packaged server did not start')
            html = request('/').decode('utf-8')
            assert 'view-vault-search' in html and 'demo-editorDialog' in html and 'myContracts' in html
            for asset in ['js/app.js','js/vault.js','js/vault-model.js','js/contract-facts.js','js/domain-catalog.js','js/contract-scope.js']:
                assert asset+'?v='+health['version'] in html, asset
                response=opener.open(urllib.request.Request(origin+'/'+asset+'?v='+health['version'],headers={'If-Modified-Since':'Wed, 31 Dec 2099 23:59:59 GMT'}))
                assert response.status==200 and 'no-store' in response.headers.get('Cache-Control',''),asset
                assert response.headers.get_content_type()=='application/javascript',asset
                assert response.read(),asset
            token = json.loads(re.search(r'window\.__LOCAL_OCR_TOKEN=("[^"\\]*");', html)[1])
            headers = {'Origin': origin, 'X-OCR-Token': token, 'Content-Type': 'application/octet-stream', 'X-Filename': 'synthetic.pdf', 'X-OCR-Mode': 'balanced'}
            semantic_headers = {'Origin': origin, 'X-OCR-Token': token, 'Content-Type': 'application/json'}
            semantic = json.loads(request('/api/semantic', data=json.dumps({'text': '协助拟进入证券市场的公司完成面向公众发售股份的申报准备。'}).encode(), headers=semantic_headers))
            assert any(tag['code'] == 'SEM_IPO_RELATED' for tag in semantic['semanticTags']), semantic
            image = Image.new('RGB', (1280, 800), 'white')
            draw = ImageDraw.Draw(image)
            font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 64)
            draw.text((90, 160), 'AUDIT CONTRACT', fill='black', font=font)
            draw.text((90, 280), 'Invoice 12345', fill='black', font=font)
            buffer = io.BytesIO(); image.save(buffer, format='PNG')
            pdf = fitz.open(); page = pdf.new_page(width=640, height=400); page.insert_image(page.rect, stream=buffer.getvalue()); data = pdf.tobytes(); pdf.close()
            ids = [json.loads(request('/api/jobs', data=data, headers=headers))['id'] for _ in range(2)]
            results = []
            for job_id in ids:
                for _ in range(240):
                    job = json.loads(request('/api/jobs/' + job_id))
                    if job['status'] == 'error': raise RuntimeError(job.get('error'))
                    if job['status'] == 'done': results.append(job['result']); break
                    time.sleep(.5)
                else: raise RuntimeError('Packaged OCR timed out')
            assert all('AUDIT' in result['rawText'].upper() for result in results), results
            assert len({r['workerPid'] for r in results}) == 2, 'Two worker processes were not exercised'
            assert len(json.loads(request('/api/contracts'))) == 2
            assert all(result['layoutPages'][0]['width'] == 640 for result in results)
            assert all(result['pageAudit'][0]['characters'] > 0 for result in results)
            assert all(len(result['pageAudit']) == result['pageCount'] for result in results)
            assert all(result['layoutPages'][0]['lines'] for result in results)
            assert all(result.get('peakWorkerMemoryMB',0)>0 for result in results)
            assert all('PP-OCRv4' in (result.get('ocrModel') or '') for result in results), [r.get('ocrModel') for r in results]
            for result in results:
                assert request('/api/source/' + result['id'], headers={'X-OCR-Token': token}) == data
            # Exercise packaged cancellation with a synthetic multi-page job.
            long_pdf = fitz.open()
            source_pdf = fitz.open(stream=data, filetype='pdf')
            for _ in range(8): long_pdf.insert_pdf(source_pdf)
            long_data = long_pdf.tobytes(); long_pdf.close(); source_pdf.close()
            cancel_id = json.loads(request('/api/jobs', data=long_data, headers=headers))['id']
            for _ in range(120):
                job = json.loads(request('/api/jobs/' + cancel_id))
                if job.get('progress'): break
                if job['status'] == 'error': raise RuntimeError(job.get('error'))
                time.sleep(.1)
            json.loads(request('/api/jobs/' + cancel_id + '/cancel', data=b'{}', headers=semantic_headers))
            for _ in range(240):
                job = json.loads(request('/api/jobs/' + cancel_id))
                if job['status'] == 'cancelled': break
                if job['status'] == 'done': raise RuntimeError('Cancelled synthetic task was saved')
                time.sleep(.25)
            else: raise RuntimeError('Cancellation did not reach a safe stop')
            assert len(json.loads(request('/api/contracts'))) == 2
            # Malformed input can fail and retry without blocking other documents.
            bad_id=json.loads(request('/api/jobs',data=b'not a PDF',headers=headers))['id']
            def wait_for(identifier,status,limit=240):
                for _ in range(limit):
                    item=json.loads(request('/api/jobs/'+identifier))
                    if item['status']==status:return item
                    if item['status']=='error' and status!='error':raise RuntimeError(item.get('error'))
                    time.sleep(.25)
                raise RuntimeError('Synthetic job did not reach '+status)
            assert wait_for(bad_id,'error')['retryAvailable']
            request('/api/jobs/'+bad_id+'/retry',data=b'{}',headers=semantic_headers)
            assert wait_for(bad_id,'error')['retryAvailable']
            request('/api/jobs/'+bad_id+'/discard',data=b'{}',headers=semantic_headers)
            # Save an annotation before forcibly stopping the EXE mid-document.
            first=json.loads(request('/api/contracts'))[0];first['reviewerNotes']='SYNTHETIC NOTE KEEP'
            request('/api/contracts',data=json.dumps({'action':'update','contract':first}).encode(),headers=semantic_headers)
            resume_id=json.loads(request('/api/jobs',data=long_data,headers=headers))['id']
            from recovery import checkpoint_dir
            checkpoint=checkpoint_dir(Path(env['CONTRACT_OCR_DATA_DIR'])/'queue'/(resume_id+'.progress.json'))/'1.json'
            for _ in range(240):
                if checkpoint.exists():break
                time.sleep(.1)
            else:raise RuntimeError('No checkpoint created before interruption')
            subprocess.run(['taskkill','/F','/T','/PID',str(process.pid)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
            process.wait(timeout=20)
            process=subprocess.Popen([str(executable),'--no-browser'],env=env)
            for _ in range(120):
                try:
                    html=request('/').decode('utf-8');break
                except OSError:time.sleep(.25)
            else:raise RuntimeError('EXE did not restart')
            token=json.loads(re.search(r'window\.__LOCAL_OCR_TOKEN=("[^"\\]*");',html)[1])
            headers['X-OCR-Token']=token;semantic_headers['X-OCR-Token']=token
            resumed=wait_for(resume_id,'done',limit=720)['result']
            assert resumed['resumedPages']>=1,resumed
            assert not resumed['failedPages']
            # PP-OCRv5 may omit spaces between English words; count words, not exact spacing.
            assert re.sub(r'\s+','',resumed['rawText']).upper().count('AUDITCONTRACT')>=8, resumed['rawText'][:600]
            all_contracts=json.loads(request('/api/contracts'))
            assert any(c.get('reviewerNotes')=='SYNTHETIC NOTE KEEP' for c in all_contracts)
            import zipfile
            backup=request('/api/backup',data=b'',headers=semantic_headers)
            with zipfile.ZipFile(io.BytesIO(backup)) as archive:
                assert archive.testzip() is None
                assert not json.loads(archive.read('backup_manifest.json'))['missingOriginals']
                assert len([name for name in archive.namelist() if name.startswith('contracts/')])==3
            cache_started=time.perf_counter()
            cached_id=json.loads(request('/api/jobs',data=data,headers=headers))['id']
            reused=wait_for(cached_id,'done')['result']
            cache_elapsed=round(time.perf_counter()-cache_started,3)
            assert reused.get('ocrCacheHit'), 'Repeated scanned PDF must bypass the OCR pool'
            assert reused['rawText']==results[0]['rawText']
            assert reused['layoutPages']==results[0]['layoutPages']
            assert reused['seconds']==0
            for _ in range(240):
                analyzed=next(c for c in json.loads(request('/api/contracts')) if c['id']==cached_id)
                if analyzed.get('analysisStatus')=='done':break
                if analyzed.get('analysisStatus')=='error':raise RuntimeError(analyzed.get('analysisError'))
                time.sleep(.25)
            else:raise RuntimeError('Independent analysis did not complete')
            timing={'originalScannedOCRSeconds':round(results[0]['seconds'],3),'cachedUploadToSavedSeconds':cache_elapsed,'cachedOCRSeconds':reused['seconds']}
            print('PASS scanned OCR cache, exact text/layout preservation, independent analysis:',json.dumps(timing))
            Path('packaged-validation.json').write_text(json.dumps({'version':health['version'],'syntheticOnly':True,'workers':health['workers'],'timing':timing,'resumedPages':resumed['resumedPages'],'checks':['two workers','OCR page geometry','semantic model','cancellation','invalid input isolation','retry','forced EXE restart and checkpoint resume','saved notes','backup original bytes and archive integrity']}),encoding='utf-8')
            print('Packaged Windows regression passed: OCR, semantics, cancellation, retry, forced restart/resume, annotation persistence and complete backup.')
        finally:
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(process.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            process.wait(timeout=20)


if __name__ == '__main__':
    main()
