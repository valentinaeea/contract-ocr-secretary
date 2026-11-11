"""Cancellation races using synthetic metadata, no OCR model or client documents."""
import concurrent.futures
import os
from pathlib import Path
import sys
import tempfile
import unittest

scratch = tempfile.TemporaryDirectory()
os.environ['CONTRACT_OCR_DATA_DIR'] = str(Path(scratch.name) / 'data')
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import desktop
from documents import check_cancelled


class CancellationTests(unittest.TestCase):
    def setUp(self):
        desktop.initialize_store()
        desktop.clear_records('jobs')
        desktop.clear_records('contracts')
        desktop.JOB_FUTURES.clear()
        desktop.put('contracts', 'keep', {'id': 'keep', 'rawText': 'already completed'})

    def job(self, identifier, running=False):
        job = {'id': identifier, 'filename': 'synthetic.pdf', 'fileSize': 1, 'status': 'queued', 'createdAt': 1}
        source = desktop.DATA_ROOT / 'queue' / (identifier + '.input')
        progress = desktop.DATA_ROOT / 'queue' / (identifier + '.progress.json')
        source.write_bytes(b'synthetic')
        future = concurrent.futures.Future()
        if running: future.set_running_or_notify_cancel()
        desktop.put('jobs', identifier, job)
        desktop.JOB_FUTURES[identifier] = future
        future.add_done_callback(lambda completed: desktop.finish_job(completed, job, source, progress))
        return future, source, progress

    def test_legacy_sqlite_import_is_one_time(self):
        import sqlite3, json
        with sqlite3.connect(desktop.DB_PATH) as connection:
            for table, column in [('contracts', 'id'), ('jobs', 'id'), ('config', 'key')]:
                connection.execute(f'CREATE TABLE IF NOT EXISTS {table} ({column} TEXT PRIMARY KEY,payload TEXT)')
            connection.execute('INSERT OR REPLACE INTO contracts VALUES (?,?)', ('legacy', json.dumps({'id': 'legacy', 'rawText': 'completed legacy result'})))
            connection.execute('INSERT OR REPLACE INTO config VALUES (?,?)', ('main', json.dumps({'partyAKeys': 'customer'})))
        connection.close()  # sqlite3's transaction context does not close the Windows file handle.
        (desktop.DATA_ROOT / 'storage_version.json').unlink()
        desktop.initialize_store()
        self.assertTrue(any(c['id'] == 'legacy' for c in desktop.records('contracts')))
        self.assertTrue(any(c['key'] == 'main' and c['value']['partyAKeys'] == 'customer' for c in desktop.records('config')))
        desktop.clear_records('contracts')
        desktop.initialize_store()
        self.assertEqual(desktop.records('contracts'), [])
        desktop.DB_PATH.unlink(missing_ok=True)

    def test_queued_cancel_never_saves_result(self):
        future, source, _ = self.job('queued')
        desktop.cancel_job('queued')
        self.assertTrue(future.cancelled())
        self.assertEqual(desktop.records('jobs')[0]['status'], 'cancelled')
        self.assertFalse(source.exists())
        self.assertEqual(len(desktop.records('contracts')), 1)

    def test_running_stops_at_safe_boundary(self):
        future, source, progress = self.job('running', running=True)
        desktop.cancel_job('running')
        with self.assertRaisesRegex(RuntimeError, 'TASK_CANCELLED'): check_cancelled(progress)
        future.set_exception(RuntimeError('TASK_CANCELLED'))
        self.assertEqual(desktop.records('jobs')[0]['status'], 'cancelled')
        self.assertFalse(source.exists())
        self.assertEqual(len(desktop.records('contracts')), 1)

    def test_late_success_after_cancel_is_not_saved(self):
        future, _, _ = self.job('late', running=True)
        desktop.cancel_job('late')
        future.set_result({'rawText': 'must not persist', 'pageCount': 1})
        self.assertEqual(desktop.records('jobs')[0]['status'], 'cancelled')
        self.assertEqual(len(desktop.records('contracts')), 1)

    def test_completed_job_is_preserved(self):
        future, _, _ = self.job('complete', running=True)
        future.set_result({'rawText': 'completed', 'pageCount': 1})
        response = desktop.cancel_job('complete')
        self.assertTrue(response['alreadyFinished'])
        self.assertEqual(len(desktop.records('contracts')), 2)


if __name__ == '__main__':
    try:
        unittest.main()
    finally:
        scratch.cleanup()
