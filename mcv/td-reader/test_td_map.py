import json
import tempfile
import unittest
import zlib
from pathlib import Path
from td_reader import open_database
from td_map import snapshot, RULES
NOW=1792698600
class MapTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.folder=Path(self.temp.name);self.db=open_database(self.folder/'td.sqlite3');self.addCleanup(self.db.close)
        self.counter=0
    def event(self,kind='CA',desc='2I30',start='0702',end='0581',stamp=NOW-10,area='M3',received=NOW):
        self.counter+=1
        body={'msg_type':kind,'area_id':area,'descr':desc,'from':start,'to':end,'time':str(stamp*1000)}
        with self.db:self.db.execute('INSERT INTO td_batches VALUES (?,?,?,?,?,?,?,?)',('TD',0,self.counter,received,None,1,zlib.compress(json.dumps([{kind+'_MSG':body}]).encode()),None))
    def test_real_arrivals_and_shared_interpose(self):
        self.event();self.event(desc='2W68',start='0610',end='0803')
        result=snapshot(self.folder,NOW)
        self.assertEqual([(r['headcode'],r['platforms'],r['offset']) for r in result['berths']],[('2I30',['5'],49),('2W68',['4'],74)])
        self.event(kind='CC',desc='2J27',end='0581',stamp=NOW)
        row=snapshot(self.folder,NOW)['berths'][1]
        self.assertEqual(row['platforms'],['3','5']);self.assertEqual(row['event'],'description')
    def test_departure_cancel_and_conflicting_description(self):
        self.event();self.event(start='0581',end='0583',stamp=NOW-5)
        result=snapshot(self.folder,NOW);self.assertEqual(result['berths'],[])
        self.assertEqual(result['events'][-1]['event'],'departure')
        self.event(kind='CC',desc='2W68',end='0803',stamp=NOW-4)
        self.event(kind='CB',desc='2I30',start='0803',stamp=NOW-3)
        self.assertEqual(len(snapshot(self.folder,NOW)['berths']),1)
        self.event(kind='CB',desc='2W68',start='0803',stamp=NOW-2)
        self.assertEqual(snapshot(self.folder,NOW)['berths'],[])
    def test_old_delayed_future_and_other_area_excluded(self):
        self.event(stamp=NOW-700);self.event(stamp=NOW+100);self.event(area='M2')
        self.assertEqual(snapshot(self.folder,NOW)['berths'],[])
    def test_order_uses_event_time_not_receipt_and_restart_replays(self):
        self.event(start='0581',end='0583',stamp=NOW-5)
        self.event(stamp=NOW-10)
        self.assertEqual(snapshot(self.folder,NOW)['berths'],[])
        self.assertEqual(snapshot(self.folder,NOW),snapshot(self.folder,NOW))
    def test_reference_rules(self):
        self.assertIn(('4','arrival','0610','0803',74),RULES)
        self.assertIn(('5','arrival','0702','0581',49),RULES)
        self.assertIn(('3','departure','0581','0615',-19),RULES)
if __name__=='__main__':unittest.main()
