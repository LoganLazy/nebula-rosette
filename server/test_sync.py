"""Regression tests using actual routes and isolated SQLite, no network/credentials."""
import tempfile
import unittest
from pathlib import Path

import db
import main
from fastapi import HTTPException
from pydantic import ValidationError


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path = db.DB_PATH
        db.DB_PATH = Path(self.temp.name) / 'test.db'
        db.init_db()
        with db.get_db() as c:
            self.user = db.create_user(c, 'alice', 'test-only')
        self.empty = {'periods': [], 'notes': {}, 'revision': 0}
        self.period = {'start': '2026-09-01', 'end': '2026-09-07'}

    def tearDown(self):
        db.DB_PATH = self.old_path
        self.temp.cleanup()

    def push(self, base, periods, notes=None):
        return main.put_data(main.SyncPayload(syncBase=base, periods=periods, notes=notes or {}),
                             self.user)['snapshot']

    def test_stale_device_does_not_resurrect_period_or_note(self):
        first = self.push(self.empty, [self.period], {'2026-09-02': {'text': 'old'}})
        self.push(first, [])
        result = self.push(first, first['periods'], first['notes'])
        self.assertEqual(result['periods'], [])
        self.assertEqual(result['notes'], {})

    def test_correct_end_earlier_and_reopen(self):
        first = self.push(self.empty, [self.period])
        corrected = self.push(first, [{**self.period, 'end': '2026-09-05'}])
        self.assertEqual(corrected['periods'][0]['end'], '2026-09-05')
        unchanged = self.push(first, first['periods'])
        self.assertEqual(unchanged['periods'][0]['end'], '2026-09-05')
        reopened = self.push(corrected, [{**self.period, 'end': None}])
        self.assertIsNone(reopened['periods'][0]['end'])

    def test_independent_changes_merge(self):
        first = self.push(self.empty, [self.period])
        self.push(first, first['periods'], {'2026-09-02': {'text': 'device A'}})
        result = self.push(first, [{**self.period, 'end': '2026-09-05'}])
        self.assertEqual(result['notes']['2026-09-02']['text'], 'device A')
        self.assertEqual(result['periods'][0]['end'], '2026-09-05')

    def test_conflict_is_atomic(self):
        first = self.push(self.empty, [self.period])
        remote = self.push(first, [{**self.period, 'end': '2026-09-05'}])
        with self.assertRaises(HTTPException) as caught:
            self.push(first, [{**self.period, 'end': '2026-09-06'}], {'2026-09-04': {'text': 'new'}})
        self.assertEqual(caught.exception.status_code, 409)
        self.assertIn('2026-09-01', caught.exception.detail)
        now = main.get_data(self.user)
        self.assertEqual(now['periods'], remote['periods'])
        self.assertEqual(now['notes'], {})

    def test_clear_blocks_old_and_unbased_clients(self):
        first = self.push(self.empty, [self.period])
        main.replace_data(main.SyncPayload(), self.user)
        self.assertEqual(self.push(first, first['periods'])['periods'], [])
        with self.assertRaises(HTTPException):
            self.push(self.empty, first['periods'])
        with self.assertRaises(HTTPException):
            main.put_data(main.SyncPayload(periods=first['periods']), self.user)

    def test_explicit_recreate_after_observing_delete(self):
        first = self.push(self.empty, [self.period])
        cleared = self.push(first, [])
        self.assertEqual(self.push(cleared, [self.period])['periods'], [self.period])

    def test_schema_upgrade_is_idempotent(self):
        db.init_db()
        db.init_db()
        self.assertEqual(self.push(self.empty, [self.period])['periods'], [self.period])

    def test_calendar_dates(self):
        for invalid in ['2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01']:
            with self.subTest(date=invalid), self.assertRaises(ValidationError):
                main.SyncPayload(periods=[{'start': invalid}])
        main.SyncPayload(periods=[{'start': '2024-02-29'}])

    def test_end_cannot_precede_start(self):
        with self.assertRaises(ValidationError):
            main.SyncPayload(periods=[{'start': '2026-09-05', 'end': '2026-09-01'}])

    def test_duplicate_periods_rejected(self):
        for cls in (main.SyncPayload, main.SyncBase):
            with self.subTest(model=cls.__name__), self.assertRaises(ValidationError):
                cls(periods=[self.period, {**self.period, 'end': None}])

    def test_notes_and_deletions_validate_dates(self):
        for cls in (main.SyncPayload, main.SyncBase):
            with self.subTest(model=cls.__name__), self.assertRaises(ValidationError):
                cls(notes={'2026-02-30': {'text': 'invalid'}})
        with self.assertRaises(ValidationError):
            main.SyncPayload(deletedPeriods=['2026-02-30'])


if __name__ == '__main__':
    unittest.main()
