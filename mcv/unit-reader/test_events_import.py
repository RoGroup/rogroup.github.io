import copy
import datetime as dt
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from events_import import normalize,publish,safe_url,text

NOW='2026-10-26T16:00:00+00:00'
def fixture():
    return {'places':[{'place_id':1,'name':'Arena','address':'Station Approach','town':'Manchester','postal_code':'M3','properties':{'place.capacity.max':'21000'},'stations':[['MCV',0.13],['MAN',1.49]]}],
        'events':[{'event_id':2,'name':'Concert','status':'live','category':'Music','descriptions':[{'type':'description.official','description':'A <b>concert</b> &amp; show<script>ignore()</script>'}],'tags':['Rock'],
            'schedules':[{'place_id':1,'start_ts':'2026-10-26T19:00:00+00:00','end_ts':'2026-10-27T19:00:00+00:00','performances':[{'ts':'2026-10-26T19:00:00+00:00','duration':120,'properties':{'capacity.calculated':'15000'},'links':[{'type':'booking','url':'https://example.org/tickets'}]},{'ts':'2026-10-27T19:00:00+00:00'}]}]}]}
class EventsImportTests(unittest.TestCase):
    def test_performance_end_uses_duration_not_schedule_end(self):
        result=normalize(fixture(),NOW);first,second=result['performances']
        self.assertEqual(first['end'],'2026-10-26T21:00:00+00:00');self.assertIsNone(second['end'])
        self.assertEqual(first['capacity'],15000);self.assertEqual(second['capacity'],21000)
        self.assertEqual(second['capacitySource'],'Venue maximum');self.assertEqual(result['places'][0]['nearestStation'],'MCV')
        self.assertEqual(result['events'][0]['description'],'A concert & show')
    def test_unknown_time_does_not_become_midnight(self):
        data=fixture();data['events'][0]['schedules'][0]['performances']=[{'ts':'2026-10-26','time_unknown':'Times tbc','duration':90}]
        row=normalize(data,NOW)['performances'][0];self.assertEqual(row['start'],'2026-10-26');self.assertIsNone(row['end']);self.assertEqual(row['timeUnknown'],'Times tbc')
    def test_overnight_and_offset_time(self):
        data=fixture();data['events'][0]['schedules'][0]['performances']=[{'ts':'2027-07-26T23:00:00+01:00','duration':180}]
        self.assertEqual(normalize(data,NOW)['performances'][0]['end'],'2027-07-27T02:00:00+01:00')
    def test_cancelled_sold_out_and_missing_capacity(self):
        data=fixture();data['places'][0]['properties']={};p=data['events'][0]['schedules'][0]['performances'][0];p['properties']={'performance.cancelled':True,'performance.sold-out':True}
        row=normalize(data,NOW)['performances'][0];self.assertTrue(row['cancelled']);self.assertTrue(row['soldOut']);self.assertIsNone(row['capacity'])
    def test_malformed_file_and_unresolved_venue_fail(self):
        for data in [{}, {'events':[],'places':{}}, {**fixture(),'places':[]}]:
            with self.assertRaises((ValueError,KeyError)):normalize(data,NOW)
    def test_duplicate_performances_are_deduped_or_conflict_rejected(self):
        data=fixture();schedule=data['events'][0]['schedules'][0];schedule['performances'].append(copy.deepcopy(schedule['performances'][0]));self.assertEqual(len(normalize(data,NOW)['performances']),2)
        schedule['performances'][-1]['duration']=180
        with self.assertRaises(ValueError):normalize(data,NOW)
    def test_safe_links_and_description(self):
        for url in ['javascript:alert(1)','data:text/html,hi','https://user:pass@example.org','//example.org']:self.assertEqual(safe_url(url),'')
        self.assertEqual(text('<style>bad</style><p>hello</p>'),'hello')
    def test_empty_snapshot_can_replace_old_data(self):
        self.assertEqual(normalize({'events':[],'places':[]},NOW)['performances'],[])
    def test_unchanged_file_does_not_publish_and_failed_upload_does_not_ack(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);source=folder/'manchester_bi.json';source.write_text(json.dumps(fixture()));os.utime(source,(0,0));(folder/'unit-ingest-token.txt').write_text('a'*40)
            class Response:
                status=200
                def __enter__(self):return self
                def __exit__(self,*args):pass
            with patch('events_import.urllib.request.urlopen',return_value=Response()) as request:
                publish(source,folder);publish(source,folder);self.assertEqual(request.call_count,1)
            marker=(folder/'events-published.json').read_text();os.utime(source,(1000,1000))
            with patch('events_import.urllib.request.urlopen',side_effect=OSError('Unavailable')):
                with self.assertRaises(OSError):publish(source,folder)
            self.assertEqual((folder/'events-published.json').read_text(),marker)
    def test_symlink_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);file=folder/'source.json';file.write_text('{}');link=folder/'link.json';link.symlink_to(file)
            with self.assertRaises(ValueError):publish(link,folder,check=True)
if __name__=='__main__':unittest.main()
