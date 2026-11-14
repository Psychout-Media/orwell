"""A/B autopilot: drives the daemon mailbox with a fixed phase->action policy. usage: ab.py RUN START_N MAX_TURNS
Casting script is fixed; afterwards: card -> pick 0 (+text for goodbye-ish), else a phase-keyed text. Stops at MAX_TURNS or finished."""
import json, sys, time, os
RUN, N0, MAXT = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
CAST = ["Hi! My name is Rowan, I am a firefighter, and I am ready to start.",
        "It went looking for me, I guess. My dad was a volunteer firefighter.",
        "I'm 34. Skip the photo. I'd play loyal but I don't trust easily.",
        "I'd take the word and hope. Then if it breaks, I don't forget it.",
        "That's all I've got. I'm ready, let's go in.",
        "I introduce myself properly to a few people and chat about where they are from.",
        "I grab a drink and ask someone what they think of the house."]
TXT = {"hoh": "Run the competition and tell me who wins.", "nom": "Go to nominations. Who is nominated?",
       "vetoc": "Go to the veto ceremony.", "veto": "Run the veto competition. Who won?",
       "evic": "Continue to eviction night.", "other": "Continue."}
def phase_text(ph):
    ph = (ph or "").lower()
    if ph.startswith("hoh"): return TXT["hoh"]
    if ph.startswith("nomin"): return TXT["nom"]
    if ph.startswith("veto-cer"): return TXT["vetoc"]
    if ph.startswith("veto"): return TXT["veto"]
    if "evict" in ph: return TXT["evic"]
    return TXT["other"]
def send(n, text, card):
    json.dump({"n": n, "text": text, "card": card}, open(f"{RUN}/req.json", "w"))
    for _ in range(200):
        time.sleep(3)
        try: r = json.load(open(f"{RUN}/resp.json"))
        except Exception: continue
        if r["n"] == n: return r
    return None
n = N0; st = {}; card = None; turns = 0
for t in CAST:
    n += 1; r = send(n, t, None); turns += 1
    if r: st, card = r["status"], r["card"]
while turns < MAXT:
    n += 1; turns += 1
    if card:
        c = {"pick": [0]}
        if any(k in (card.get("title", "")).lower() for k in ("goodbye", "message")): c["text"] = "Take care out there."
        r = send(n, None, c)
    else:
        r = send(n, phase_text(st.get("phase")), None)
    if not r: print("timeout at", n, flush=True); break
    st, card = r["status"], r["card"]
    print(f"t{n} {r['secs']}s week={st.get('week')} phase={st.get('phase')} card={bool(card)}", flush=True)
    if st.get("finished") or (st.get("week") or 0) > int(os.environ.get("AB_MAXWEEK", "99")): break
