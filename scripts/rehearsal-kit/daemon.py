"""A-11 play daemon: file mailbox. req.json={"n":int,"text":str|null,"card":{"pick":[idx...],"text":str}|null,"shot":bool}
resp.json={"n","bubbles":[..new AI bubbles raw..],"card":{title,opts}|null,"status":{...},"secs":float}"""
import json, os, sys, time, re
from playwright.sync_api import sync_playwright

def _rig_base(run):
    """The front-end base URL for this run's slot: the run's own slot.env RIG_BASE is authoritative (an exported RIG_BASE that disagrees is refused); the environment is used only when there is no slot.env, then the slot-1 default (a run staged before slots existed has no slot.env)."""
    import shlex
    rec = None
    try:   # the run's own slot.env is authoritative: a stray exported RIG_BASE must never point the daemon at the other rig
        for ln in open(f"{run}/slot.env"):
            k, _, v = ln.strip().partition("=")
            if k == "RIG_BASE" and v: rec = shlex.split(v)[0]
    except OSError: pass
    env = os.environ.get("RIG_BASE")
    if rec and env and env != rec: sys.exit(f"FATAL: RIG_BASE={env} disagrees with this run's slot.env ({rec}); refusing to drive the wrong rig")
    return rec or env or "http://127.0.0.1:17000"  # slot-1 default (a run staged before slots existed has no slot.env)
RUN = sys.argv[1]; BASE = _rig_base(RUN)
REQ, RESP = f"{RUN}/req.json", f"{RUN}/resp.json"
turnlog = open(f"{RUN}/turnlog.txt", "a"); transcript = open(f"{RUN}/transcript.txt", "a")
turns_log = open(f"{RUN}/turns.jsonl", "a")   # ORW-109: one JSON line per turn (judge_transcript.py reads it)
def log(s): turnlog.write(s + "\n"); turnlog.flush()
BUB = """() => [...document.querySelectorAll('#chat-history .msg-ai')].map(el => { const c = el.cloneNode(true);
  c.querySelectorAll('.thinking-content,.thinking,[class*=thinking],.msg-footer').forEach(n=>n.remove());
  return {txt:(c.innerText||'').trim(), think:!!el.querySelector('.thinking-content,.thinking,[class*=thinking]'), done:!!el.querySelector('.msg-footer')}; })"""
CARD = """() => { const d=document.querySelector('#orwell-decision-card'); if(!d) return null;
  return {title:(d.querySelector('.odec-title')||{}).innerText||'', opts:[...d.querySelectorAll('.odec-opt')].map(o=>o.innerText.trim()), hasText:!!d.querySelector('textarea')}; }"""
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={"width":1440,"height":900})
    ctx.add_init_script("""(()=>{window.__ann=[];const d=window.dispatchEvent.bind(window);window.dispatchEvent=function(e){try{if(e&&e.type==='orwell:announcements'){window.__ann.push({t:Date.now(),n:(e.detail&&e.detail.announcements||[]).map(a=>a.id+':'+a.kind+':'+(a.headline||'').slice(0,50))});}}catch(_){ }return d(e)};})()""")
    page = ctx.new_page()
    page.goto(BASE + "/", wait_until="load", timeout=60000); page.wait_for_timeout(6000)
    last = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    if len(sys.argv) <= 2:   # a restart must not replay the last mailbox request: resume after the durable acknowledgment
        try: last = int(json.load(open(RESP))["n"])
        except Exception: pass
    print("DAEMON READY", flush=True)
    while True:
        time.sleep(0.8)
        if not os.path.exists(REQ): continue
        try: req = json.load(open(REQ))
        except Exception: continue
        if req["n"] <= last: continue
        last = req["n"]; t0 = time.time(); before = len(page.evaluate(BUB))
        if req.get("reload"): page.reload(wait_until="load"); page.wait_for_timeout(5000)
        c = req.get("card")
        if c:
            opts = page.query_selector_all("#orwell-decision-card .odec-opt")
            for i in c.get("pick", []):
                if i < len(opts): opts[i].click(); page.wait_for_timeout(150)
            if c.get("text"):
                ta = page.query_selector("#orwell-decision-card textarea")
                if ta: ta.fill(c["text"])
            if page.query_selector("#orwell-decision-card .odec-confirm"): page.click("#orwell-decision-card .odec-confirm")
            log(f"{last}\tCARD {c}\t{time.strftime('%H:%M:%S')}")
        if req.get("text"):
            page.fill("#message", req["text"]); page.wait_for_timeout(300)
            if page.evaluate("document.querySelector('.send-btn')?.getAttribute('data-mode')") == "send": page.click(".send-btn")
            else: page.keyboard.press("Enter")
            log(f"{last}\t{req['text']}\t{time.strftime('%H:%M:%S')}")
        page.wait_for_timeout(3000)
        stable = 0; prev = None
        while time.time() - t0 < req.get("timeout", 240):
            page.wait_for_timeout(2000)
            bs = page.evaluate(BUB); sig = json.dumps([x["txt"] for x in bs])
            busy = page.evaluate("!!document.querySelector('.send-btn[data-mode=\"streaming\"]')")   # the UI's real active-generation state
            fresh = len(bs) > before or not req.get("text")   # a text turn is finished only once a NEW bubble exists (a failed submission must not report the previous reply)
            if sig == prev and not busy and fresh and (not bs or bs[-1]["done"] or len(bs) > before or stable > 4): stable += 1
            else: stable = 0
            prev = sig
            if stable >= 3: break
        bs = page.evaluate(BUB); new = bs[before:] if len(bs) >= before else bs
        card = page.evaluate(CARD)
        st = {}
        try: st = ctx.request.get(BASE + "/api/orwell/status").json()
        except Exception as e: st = {"err": str(e)}
        # ORW-109: also the board and the presence strip (what the player's screens read), so a played run can be judged afterwards turn by turn
        # (scripts/live-run/judge_transcript.py). A failed read is left out (unknown), never invented.
        board = where = None
        try: board = ctx.request.get(BASE + "/api/orwell/state").json()
        except Exception: board = None
        try: where = ctx.request.get(BASE + "/api/orwell/whereabouts").json()
        except Exception: where = None
        try: hud_tod = page.evaluate("document.querySelector('#os-tod')?.innerText || null")   # the day part the player SEES on the HUD (T14)
        except Exception: hud_tod = None
        if req.get("shot", True): page.screenshot(path=f"{RUN}/shots/t{last:03d}.png", full_page=False)
        for x in new: transcript.write(f"--- turn {last} ---\n{x['txt']}\n"); 
        transcript.flush()
        chy = page.evaluate("[...document.querySelectorAll('.ow-chyron')].map(e=>e.innerText.replace(/\\n/g,' | '))"); ann = page.evaluate("window.__ann||[]")
        json.dump({"n": last, "chyron_dom": chy, "ann_events": ann, "bubbles": [x["txt"] for x in new], "thinkSeen": any(x["think"] for x in new), "card": card, "status": st, "secs": round(time.time()-t0,1)}, open(RESP + ".tmp", "w")); os.replace(RESP + ".tmp", RESP)
        # ORW-109: keep EVERY turn (resp.json holds only the latest): the player's message, the card the player answered, the new public bubbles and the three screen reads.
        turns_log.write(json.dumps({"n": last, "msg": req.get("text"), "card_req": c, "bubbles": [x["txt"] for x in new], "card": card, "state": board, "status": st,
                                    "whereabouts": where, "hud_tod": hud_tod, "secs": round(time.time() - t0, 1), "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}) + "\n"); turns_log.flush()
        print("turn", last, "done", round(time.time()-t0), flush=True)
