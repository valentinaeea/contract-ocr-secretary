"""Windows file-sharing regressions using synthetic documents and held readers."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import desktop
from documents import progress, recognize_document

class ProgressFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.path = self.root / 'synthetic.progress.json'
    def tearDown(self):
        self.temporary.cleanup()

    def test_held_reader_does_not_prevent_progress_update(self):
        self.path.write_text('{"current":0}', encoding='utf-8')
        with self.path.open('r', encoding='utf-8') as reader:
            with patch.object(Path, 'replace', side_effect=AssertionError('Do not replace progress files')):
                self.assertTrue(progress(str(self.path), 1, 2, 'synthetic'))
            reader.seek(0)
            self.assertEqual(json.load(reader)['current'], 1)

    def test_transient_write_lock_retries(self):
        original = Path.write_text
        calls = []
        def locked(path, *args, **kwargs):
            if path == self.path:
                calls.append(1)
                if len(calls) == 1: raise PermissionError('synthetic sharing violation')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'write_text', locked), patch('documents.time.sleep'):
            self.assertTrue(progress(str(self.path), 1, 1, 'synthetic'))
        self.assertEqual(len(calls), 2)

    def test_persistent_progress_lock_does_not_fail_pdf_recognition(self):
        import pymupdf as fitz
        pdf = fitz.open(); page = pdf.new_page(); page.insert_text((72, 90), 'SYNTHETIC AUDIT CONTRACT')
        filename = self.root / 'synthetic.pdf'; pdf.save(filename); pdf.close()
        original = Path.write_text
        def locked(path, *args, **kwargs):
            if path == self.path: raise PermissionError('synthetic sharing violation')
            return original(path, *args, **kwargs)
        with patch.object(Path, 'write_text', locked), patch('documents.time.sleep'), patch('semantic.classify', return_value={'semanticTags': []}):
            result = recognize_document(str(filename), filename.name, 'balanced', str(self.path))
        self.assertIn('SYNTHETIC AUDIT CONTRACT', result['rawText'])
        self.assertEqual(result['pageCount'], 1)

    def test_cancellation_is_not_swallowed_by_progress_fallback(self):
        self.path.with_suffix('.cancel').write_text('cancel')
        with self.assertRaisesRegex(RuntimeError, 'TASK_CANCELLED'):
            progress(str(self.path), 0, 1, 'synthetic')

    def test_locked_cleanup_is_nonfatal_and_retryable(self):
        self.path.write_text('synthetic')
        with patch.object(Path, 'unlink', side_effect=PermissionError('synthetic sharing violation')), patch('desktop.time.sleep'):
            self.assertFalse(desktop.cleanup_queue_file(self.path))
        self.assertTrue(self.path.exists())
        self.assertTrue(desktop.cleanup_queue_file(self.path))
        self.assertFalse(self.path.exists())

if __name__ == '__main__': unittest.main()
