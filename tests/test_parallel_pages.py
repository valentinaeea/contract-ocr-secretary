"""Pages of one PDF spread over OCR workers: same result, checkpoints, cancellation. Synthetic only."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import desktop
import documents
from recovery import PageCheckpoint

FAIL = set()


def synthetic_page(page, page_no, total, mode, progress_path, report=True):
    documents.check_cancelled(progress_path)
    if page_no in FAIL: raise ValueError('synthetic damaged page')
    text = f'SYNTHETIC PAGE {page_no}'
    return {'text': text, 'layout': {'page': page_no, 'width': 600, 'height': 800, 'lines': [{'text': text}]},
            'audit': {'page': page_no, 'nearBlank': False}, 'notes': [], 'ocrUsed': True}


class ParallelPageTests(unittest.TestCase):
    def setUp(self):
        import pymupdf as fitz
        self.tmp = tempfile.TemporaryDirectory(); root = Path(self.tmp.name)
        self.previous = desktop.DATA_ROOT, desktop.DB_PATH
        desktop.DATA_ROOT = root / 'data'; desktop.DB_PATH = desktop.DATA_ROOT / 'state.sqlite3'; desktop.initialize_store()
        doc = fitz.open()
        for _ in range(6): doc.new_page()
        self.pdf = root / 'synthetic.pdf'; doc.save(self.pdf); doc.close()
        self.progress = desktop.DATA_ROOT / 'queue' / 'p.progress.json'
        FAIL.clear()

    def tearDown(self):
        desktop.DATA_ROOT, desktop.DB_PATH = self.previous; self.tmp.cleanup(); FAIL.clear()

    def parallel(self, pool, window=2):
        return documents.recognize_document_parallel(pool.submit, str(self.pdf), self.pdf.name, 'balanced', str(self.progress), window=window)

    def test_parallel_matches_sequential(self):
        with patch('documents.recognize_pdf_page', synthetic_page):
            sequential = documents.recognize_document(str(self.pdf), self.pdf.name, 'balanced', str(desktop.DATA_ROOT / 'queue' / 's.progress.json'))
            with concurrent.futures.ThreadPoolExecutor(3) as pool: parallel = self.parallel(pool, 3)
        for key in ['rawText', 'layoutPages', 'failedPages', 'pageCount', 'reviewNotes']:
            self.assertEqual(sequential[key], parallel[key], key)
        self.assertEqual([row['page'] for row in parallel['pageAudit']], list(range(1, 7)))
        self.assertEqual(json.loads(self.progress.read_text(encoding='utf-8'))['current'], 6)

    def test_failed_page_retry_reuses_other_pages(self):
        FAIL.add(3)
        with patch('documents.recognize_pdf_page', synthetic_page), concurrent.futures.ThreadPoolExecutor(2) as pool:
            self.assertEqual(self.parallel(pool)['failedPages'], [3])
            FAIL.clear(); result = self.parallel(pool)
        self.assertEqual(result['failedPages'], []); self.assertEqual(result['resumedPages'], 5)

    def test_cancellation_keeps_finished_checkpoints(self):
        def slow(*args, **kwargs):
            time.sleep(.15); return synthetic_page(*args, **kwargs)
        threading.Timer(.4, lambda: self.progress.with_suffix('.cancel').write_text('cancel')).start()
        with patch('documents.recognize_pdf_page', slow), concurrent.futures.ThreadPoolExecutor(2) as pool:
            with self.assertRaisesRegex(RuntimeError, 'TASK_CANCELLED'): self.parallel(pool)
        self.assertIsNotNone(PageCheckpoint(self.progress, self.pdf.read_bytes(), 'balanced').load(1))

    def test_job_files_do_not_duplicate_results(self):
        data = self.pdf.read_bytes(); (desktop.DATA_ROOT / 'queue' / 'job_p.input').write_bytes(data)
        job = {'id': 'job_p', 'filename': 'synthetic.pdf', 'fileSize': len(data), 'mode': 'balanced', 'status': 'queued', 'createdAt': 1}
        desktop.put('jobs', 'job_p', job)
        server = SimpleNamespace(worker_count=2, pool=concurrent.futures.ThreadPoolExecutor(2), coordinators=concurrent.futures.ThreadPoolExecutor(2), semantic_pool=SimpleNamespace(submit=lambda *a: concurrent.futures.Future()))
        with patch('documents.recognize_pdf_page', synthetic_page):
            desktop.submit_stored_job(server, job)
            for _ in range(200):
                if desktop.get_record('jobs', 'job_p')['status'] == 'done': break
                time.sleep(.02)
        stored = desktop.get_record('jobs', 'job_p')
        self.assertEqual(stored['status'], 'done'); self.assertNotIn('result', stored)
        self.assertIn('SYNTHETIC PAGE 6', desktop.job_result(stored)['rawText'])
        desktop.put('jobs', 'job_p', {**stored, 'result': {'rawText': 'old duplicate'}})
        desktop.initialize_store(); self.assertNotIn('result', desktop.get_record('jobs', 'job_p'))


if __name__ == '__main__': unittest.main()
