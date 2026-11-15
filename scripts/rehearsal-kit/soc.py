"""soc.py RUN N0 'line1' 'line2' ... : send each line as a player message (auto-answering any open decision card first). Prints compact status + GM reply head."""
import json, sys, time
RUN, N = sys.argv[1], int(sys.argv[2]); LINES = sys.argv[3:]
def send(n, text, card):
    json.dump({"n": n, "text": text, "card": card}, open(f"{RUN}/req.json", "w"))
    for _ in range(200):
        time.sleep(3)
        try: r = json.load(open(f"{RUN}/resp.json"))
        except Exception: continue
        if r["n"] == n: return r
def show(n, r, label):
    s = r["status"]; ds = s.get("daySchedule") or {}
    ph = s.get("phase"); wk = s.get("week")
    hoh = s.get("hoh"); hoh = hoh.get("name") if isinstance(hoh, dict) else hoh
    print(f"[{n} {r['secs']}s w{wk} {ph} t={s.get('timeOfDay')} due={ds.get('due')} card={'Y' if r['card'] else '-'}] {label}")
    for b in r["bubbles"][:1]: print("   GM>", b.replace("\n", " ")[:260])
    if r["card"]: print("   CARD>", r["card"]["title"][:60], r["card"]["opts"][:4])
last = json.load(open(f"{RUN}/resp.json")) if N > 0 else None
for line in LINES:
    while last and last.get("card"):
        N += 1
        c = {"pick": [0]}
        if any(k in last["card"]["title"].lower() for k in ("goodbye", "message")): c["text"] = "Take care out there."
        last = send(N, None, c); show(N, last, "(card) pick 0")
    N += 1
    last = send(N, line, None); show(N, last, line[:70])
print("NEXT_N", N)
