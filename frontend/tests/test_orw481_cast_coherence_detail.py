"""Review of ORW-145: the cast-coherence failure detail stays complete, valid JSON within the ledger's cap, even when many houseguests were corrected. Roles only."""
import json

from src import tool_implementations as ti


def _many(n):
    return [{"id": f"npc:{i}", "action": "repaired", "fields": ["background", "age", "presentation", "demeanor"]} for i in range(n)]


def test_a_few_corrected_houseguests_keep_every_field_name():
    d = json.loads(ti._cast_coherence_detail(2, 0, _many(2)))
    assert [h["id"] for h in d["houseguests"]] == ["npc:0", "npc:1"] and d["houseguests"][0]["fields"][0] == "background"


def test_a_full_cast_of_corrections_stays_valid_json_under_the_cap_and_keeps_every_id():
    raw = _many(15)
    s = ti._cast_coherence_detail(15, 0, raw)
    assert len(s) <= ti._RECORD_FAILURE_DETAIL_CAP
    d = json.loads(s)  # never cut mid-record
    assert [h["id"] for h in d["houseguests"]] == [h["id"] for h in raw], "later ids are not lost"
    assert d["repaired"] == 15


def test_when_even_ids_do_not_fit_the_omission_is_said_not_silent():
    s = ti._cast_coherence_detail(100, 0, [{"id": f"npc:{i}", "action": "repaired", "fields": []} for i in range(100)])
    d = json.loads(s)
    assert len(s) <= ti._RECORD_FAILURE_DETAIL_CAP and d["omitted"] > 0 and len(d["houseguests"]) + d["omitted"] == 100
