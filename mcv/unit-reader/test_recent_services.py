import datetime as dt
import tempfile
import unittest
from pathlib import Path

from recent_services import capture, mark_uploaded, booked

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 10, 22, 14, tzinfo=UTC)
SERVICE = dict(serviceID='s1', uid='P12345', trainid='2N01', sdd='2026-10-22',
               sta='2026-10-22T14:55:00', std='2026-10-22T15:00:00',
               origin=[dict(locationName='Leeds')], destination=[dict(locationName='Liverpool')], atd='')
ALLOCATION = {**SERVICE, 'status': 'allocated', 'arrivalUnits': ['150123'], 'departureUnits': ['150456']}
EVENT = dict(kind='arrival', at='2026-10-22T13:56:00Z', timeBasis='actual', locationName='Manchester Victoria', crs='MCV', tiploc='MNCRVIC', platform='4', delaySeconds=60)
HISTORY = {**SERVICE, 'events': [EVENT], 'reconciliationRequired': False}


class RecentServicesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def capture(self, services=None, allocations=None, trust=None, now=NOW):
        return capture(self.folder, [SERVICE] if services is None else services,
                       [ALLOCATION] if allocations is None else allocations,
                       {'available': True, 'histories': [HISTORY]} if trust is None else trust, now)

    def test_persistent_observations_and_upload_cadence(self):
        archive, due = self.capture()
        self.assertTrue(due)
        row = archive['services'][0]
        self.assertEqual(row['std'], '2026-10-22T14:00:00+00:00')
        self.assertEqual(row['history']['events'], [EVENT])
        self.assertEqual(row['allocation']['departureUnits'], ['150456'])
        self.assertNotIn('xml', row)
        mark_uploaded(self.folder, NOW)
        archive, due = self.capture(services=[], now=NOW + dt.timedelta(minutes=2))
        self.assertFalse(due)
        self.assertEqual(archive['services'][0], row, 'Services remain after leaving the board')
        self.assertEqual(archive['startedAt'], NOW.isoformat())
        self.assertTrue(self.capture(services=[], now=NOW + dt.timedelta(minutes=10))[1])

    def test_missing_data_preserves_time_of_last_confirmed_evidence(self):
        self.capture()
        rows = self.capture(allocations=[], trust={'available': False}, now=NOW+dt.timedelta(minutes=2))[0]['services']
        self.assertEqual(rows[0]['allocation']['capturedAt'], NOW.isoformat())
        self.assertEqual(rows[0]['history']['capturedAt'], NOW.isoformat())
        self.assertNotEqual(rows[0]['lastSeen'], rows[0]['allocation']['capturedAt'])
        allocation = {**ALLOCATION, 'status': 'unallocated', 'arrivalUnits': [], 'departureUnits': []}
        row = self.capture(allocations=[allocation])[0]['services'][0]
        self.assertEqual(row['allocation']['status'], 'unallocated')
        self.assertEqual(row['allocation']['departureUnits'], [])

    def test_exact_identity_and_ambiguous_history(self):
        other = {**HISTORY, 'trainid': '2N02'}
        row = self.capture(trust={'available': True, 'histories': [other]})[0]['services'][0]
        self.assertNotIn('history', row)
        row = self.capture(trust={'available': True, 'histories': [HISTORY, HISTORY]})[0]['services'][0]
        self.assertNotIn('history', row)
        other = {**HISTORY, 'std': '2026-10-22T14:02:00Z'}
        row = self.capture(trust={'available': True, 'histories': [other]})[0]['services'][0]
        self.assertNotIn('history', row)
        # Offset-bearing TRUST and offset-free Darwin booked times match.
        history = {**HISTORY, 'sta': '2026-10-22T13:55:00Z', 'std': '2026-10-22T14:00:00Z'}
        self.assertIn('history', self.capture(trust={'available': True, 'histories': [history]})[0]['services'][0])

    def test_retention_and_repeated_headcode_dates(self):
        self.capture()
        tomorrow = {**SERVICE, 'sdd': '2026-10-23', 'sta': '2026-10-23T14:55:00', 'std': '2026-10-23T15:00:00'}
        archive, _ = self.capture(services=[tomorrow], allocations=[], now=NOW+dt.timedelta(days=1))
        self.assertEqual(len(archive['services']), 2)
        self.assertEqual(len(self.capture(services=[], now=NOW+dt.timedelta(hours=49))[0]['services']), 1)
        self.assertEqual(len(self.capture(services=[], now=NOW+dt.timedelta(hours=73))[0]['services']), 0)

    def test_no_guessing_missing_identity_or_clock_only_date(self):
        for changes in [{'uid': ''}, {'trainid': ''}, {'std': '15:00', 'sta': ''}]:
            self.assertEqual(self.capture(services=[{**SERVICE, **changes}])[0]['services'], [])
        self.assertIsNone(booked('15:00'))
        self.assertEqual(booked('2026-10-24T23:59:00'), '2026-10-24T22:59:00+00:00')
        self.assertEqual(booked('2026-10-26T00:01:00'), '2026-10-26T00:01:00+00:00')


if __name__ == '__main__':
    unittest.main()
