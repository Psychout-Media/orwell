"""A-11 play daemon: file mailbox. req.json={"n":int,"text":str|null,"card":{"pick":[idx...],"text":str}|null,"shot":bool}
resp.json={"n","bubbles":[..new AI bubbles raw..],"card":{title,opts}|null,"status":{...},"secs":float}"""
import json, os, sys, time, re
from playwright.sync_api import sync_playwright

def _rig_base(run):
    """The front-end base URL for this run's slot: RIG_BASE from the environment, else the run's slot.env, else the slot-1 default (a run staged before slots existed has no slot.env)."""
    import shlex
    if os.environ.get("RIG_BASE"): return os.environ["RIG_BASE"]
    try:
        for ln in open(f"{run}/slot.env"):
            k, _, v = ln.strip().partition("=")
            if k == "RIG_BASE" and v: return shlex.split(v)[0]
    except OSError: pass
    return "http://127.0.0.1:17000"  # slot-1 default
RUN = sys.argv[1]; BASE = _rig_base(RUN)
REQ, RESP = f"{RUN}/req.json", f"{RUN}/resp.json"
turnlog = open(f"{RUN}/turnlog.txt", "a"); transcript = open(f"{RUN}/transcript.txt", "a")
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
            busy = page.evaluate("!!document.querySelector('.send-btn[data-mode=\"stop\"], .send-btn[data-mode=\"cancel\"]')")
            if sig == prev and not busy and (not bs or bs[-1]["done"] or len(bs) > before or stable > 4): stable += 1
            else: stable = 0
            prev = sig
            if stable >= 3: break
        bs = page.evaluate(BUB); new = bs[before:] if len(bs) >= before else bs
        card = page.evaluate(CARD)
        st = {}
        try: st = ctx.request.get(BASE + "/api/orwell/status").json()
        except Exception as e: st = {"err": str(e)}
        if req.get("shot", True): page.screenshot(path=f"{RUN}/shots/t{last:03d}.png", full_page=False)
        for x in new: transcript.write(f"--- turn {last} ---\n{x['txt']}\n"); 
        transcript.flush()
        chy = page.evaluate("[...document.querySelectorAll('.ow-chyron')].map(e=>e.innerText.replace(/\\n/g,' | '))"); ann = page.evaluate("window.__ann||[]")
        json.dump({"n": last, "chyron_dom": chy, "ann_events": ann, "bubbles": [x["txt"] for x in new], "thinkSeen": any(x["think"] for x in new), "card": card, "status": st, "secs": round(time.time()-t0,1)}, open(RESP + ".tmp", "w")); os.replace(RESP + ".tmp", RESP)
        print("turn", last, "done", round(time.time()-t0), flush=True)
