"""Synthetic permission failures; never touches the configured shared folder."""
import errno
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
import excel_table as e

class ExcelPermissionTests(unittest.TestCase):
    def test_temp_creation_failure_has_directory_and_stage(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(e.tempfile, 'mkstemp', side_effect=PermissionError(errno.EACCES, 'denied')):
                with self.assertRaises(e.ExcelError) as caught:
                    e.merge_into_master(folder, [{'项目名称':'虚构项目'}])
            self.assertIn('创建临时 Excel', str(caught.exception))
            self.assertIn(folder, str(caught.exception))
            self.assertFalse((Path(folder)/e.MASTER_NAME).exists())

    def test_backup_failure_keeps_original(self):
        with tempfile.TemporaryDirectory() as folder:
            e.merge_into_master(folder, [{'项目名称':'原虚构项目','合同ID':'x'}])
            master=Path(folder)/e.MASTER_NAME;before=master.read_bytes()
            with patch.object(e.shutil, 'copyfile', side_effect=PermissionError(errno.EACCES, 'denied')):
                with self.assertRaises(e.ExcelError) as caught:
                    e.merge_into_master(folder, [{'项目名称':'新虚构项目','合同ID':'x'}])
            self.assertIn('备份总表', str(caught.exception))
            self.assertEqual(master.read_bytes(), before)

    def test_locked_replace_and_failed_cleanup_keep_original_error(self):
        with tempfile.TemporaryDirectory() as folder:
            e.merge_into_master(folder, [{'项目名称':'原虚构项目','合同ID':'x'}])
            master=Path(folder)/e.MASTER_NAME;before=master.read_bytes()
            with patch.object(e.os, 'replace', side_effect=PermissionError(errno.EACCES, 'locked')):
                with patch.object(e.os, 'unlink', side_effect=PermissionError(errno.EACCES, 'cleanup locked')):
                    with self.assertRaises(e.ExcelError) as caught:
                        e.merge_into_master(folder, [{'项目名称':'新虚构项目','合同ID':'x'}])
            self.assertIn('替换云盘总表', str(caught.exception))
            self.assertEqual(master.read_bytes(), before)
            self.assertEqual(master.with_name(master.stem+'.备份.xlsx').read_bytes(),before)

    def test_backup_does_not_copy_permissions_or_timestamps(self):
        with tempfile.TemporaryDirectory() as folder:
            e.merge_into_master(folder, [{'项目名称':'原虚构项目','合同ID':'x'}])
            master=Path(folder)/e.MASTER_NAME;before=master.read_bytes()
            with patch.object(e.shutil, 'copystat', side_effect=PermissionError(errno.EACCES, 'metadata denied')):
                result=e.merge_into_master(folder, [{'项目名称':'新虚构项目','合同ID':'x'}])
            self.assertEqual(result['updated'],1)
            self.assertEqual(master.with_name(master.stem+'.备份.xlsx').read_bytes(),before)
            self.assertEqual(e.read_xlsx(master.read_bytes())[1][0]['项目名称'],'新虚构项目')
