"""Synthetic model metadata verifies vocabulary order, classes and profile consistency."""
import sys,unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'native'))
from ocr_dictionary import dictionary_from_sessions
class FakeSession:
    def __init__(self,characters,classes):self.characters=characters;self.classes=classes
    def get_modelmeta(self):return SimpleNamespace(custom_metadata_map={} if self.characters is None else {'character':self.characters})
    def get_outputs(self):return [SimpleNamespace(shape=[1,20,self.classes])]
class DictionaryTests(unittest.TestCase):
    def test_exact_order_and_whitespace_are_preserved(self):
        a=FakeSession('年\n月\n日\n0\n1\n\u3000',8)
        self.assertEqual(dictionary_from_sessions([a,a]),['年','月','日','0','1','\u3000'])
    def test_missing_metadata_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'no embedded'):dictionary_from_sessions([FakeSession(None,2)])
    def test_wrong_class_count_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'classes'):dictionary_from_sessions([FakeSession('年\n月',10)])
    def test_different_profile_mappings_are_rejected(self):
        with self.assertRaisesRegex(ValueError,'differ'):dictionary_from_sessions([FakeSession('年\n月',4),FakeSession('月\n年',4)])
