"""Verify timetable precedence and failed-import isolation."""
import gzip
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from schedule_import import import_timetable, lookup


def schedule(uid="P28858", stp="P", start="2026-05-18", mcv=True):
    return {"JsonScheduleV1": {
        "transaction_type": "Create", "CIF_train_uid": uid,
        "CIF_stp_indicator": stp, "schedule_start_date": start,
        "schedule_end_date": "2026-12-11", "schedule_days_runs": "1111100",
        "applicable_timetable": "Y", "CIF_bank_holiday_running": None,
        "schedule_segment": {"schedule_location": [
            {"tiploc_code": "MNCRVIC" if mcv else "MNCRPIC"}]}}}


class ScheduleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.source = self.folder / "full.json.gz"
        self.output = self.folder / "schedules.sqlite3"

    def write(self, records, eof=True, kind="full"):
        with gzip.open(self.source, "wt") as stream:
            stream.write(json.dumps({"JsonTimetableV1": {"Metadata": {"type": kind}}}) + "\n")
            for record in records:
                stream.write(json.dumps(record) + "\n")
            if eof:
                stream.write('{"EOF": {}}\n')

    def load(self):
        import_timetable(self.source, self.output, report=lambda *args, **kwargs: None)

    def test_cancellation_and_diverted_overlay_win_even_without_mcv_locations(self):
        cancelled = schedule(uid="P00001", stp="C", start="2026-10-22", mcv=False)
        self.write([schedule(), schedule(stp="O", start="2026-10-22", mcv=False),
                    cancelled, schedule(uid="P00001"), schedule(uid="P99999", mcv=False)])
        self.load()
        with sqlite3.connect(self.output) as db:
            self.assertEqual(lookup(db, "P28858", "2026-10-22")["status"], "does-not-visit-mcv")
            self.assertEqual(lookup(db, "P00001", "2026-10-22")["status"], "cancelled")
            self.assertEqual(lookup(db, "P28858", "2026-10-21")["status"], "scheduled")
            self.assertEqual(lookup(db, "P28858", "2026-10-24")["status"], "not-found")
            self.assertEqual(db.execute("SELECT count(*) FROM schedules WHERE uid='P99999'").fetchone()[0], 0)

    def test_missing_footer_and_update_file_preserve_previous_database(self):
        self.write([schedule()])
        self.load()
        original = self.output.read_bytes()
        for eof, kind in [(False, "full"), (True, "update")]:
            self.write([schedule(stp="O", start="2026-10-22")], eof=eof, kind=kind)
            with self.assertRaises(ValueError):
                self.load()
            self.assertEqual(self.output.read_bytes(), original)
            self.assertEqual(list(self.folder.glob("*.building")), [])

    def test_overlapping_equal_precedence_and_holiday_rules_are_not_guessed(self):
        holiday = schedule(uid="P00001")
        holiday["JsonScheduleV1"]["CIF_bank_holiday_running"] = "X"
        self.write([schedule(), schedule(start="2026-10-01"), holiday])
        self.load()
        with sqlite3.connect(self.output) as db:
            self.assertEqual(lookup(db, "P28858", "2026-10-22")["status"], "ambiguous")
            self.assertEqual(lookup(db, "P00001", "2026-10-22")["status"], "holiday-rule-unresolved")


if __name__ == "__main__":
    unittest.main()
