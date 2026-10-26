import types
import unittest
from vstp_reader import is_caught_up
class CatchupTests(unittest.TestCase):
    def consumer(self, offsets, bounds):
        rows=[types.SimpleNamespace(partition=i,offset=o) for i,o in enumerate(offsets)]
        return types.SimpleNamespace(assignment=lambda:rows,position=lambda _:rows,get_watermark_offsets=lambda p,**kw:bounds[p.partition])
    def test_live_partition_and_unused_empty_partition(self):
        self.assertTrue(is_caught_up(self.consumer([308186,-1001],[(306322,308186),(0,0)])))
    def test_negative_position_on_nonempty_partition_is_not_caught_up(self):
        self.assertFalse(is_caught_up(self.consumer([-1001],[(0,1)])))
    def test_real_lag_and_retention_gap_remain_unhealthy(self):
        for offset,bounds in [(100,(0,101)),(50,(100,100)),(-1001,(100,100))]:
            self.assertFalse(is_caught_up(self.consumer([offset],[bounds])))
    def test_no_assignment_or_missing_positions(self):
        self.assertFalse(is_caught_up(self.consumer([],[])))
        c=self.consumer([0],[(0,0)]);c.position=lambda _:[]
        self.assertFalse(is_caught_up(c))
    def test_zero_and_positive_offsets_at_end(self):
        self.assertTrue(is_caught_up(self.consumer([0,100],[(0,0),(50,100)])))
if __name__=='__main__':unittest.main()
