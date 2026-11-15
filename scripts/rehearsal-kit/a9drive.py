"""A9 live premiere driver (headless=old; the daemon's init-script context crashed Chromium on this box). usage: a9drive.py RUN  (reads RUN/script.txt: one message per line; '#' lines ignored). Logs to RUN/a9.log."""
import json, os, sys, time, urllib.request
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
lines = [l.rstrip("\n") for l in open(f"{RUN}/script.txt") if l.strip() and not l.startswith("#")]
out = open(f"{RUN}/a9.log", "a")
def log(s): out.write(s + "\n"); out.flush()
BUB = """() => [...document.querySelectorAll('#chat-history .msg-ai')].map(el => { const c = el.cloneNode(true);
  c.querySelectorAll('.thinking-content,.thinking,[class*=thinking],.msg-footer').forEach(n=>n.remove());
  return {txt:(c.innerText||'').trim(), done:!!el.querySelector('.msg-footer')}; })"""
def state():
    try: return json.load(urllib.request.urlopen(BASE + "/api/orwell/state", timeout=20))
    except Exception as e: return {"err": str(e)}
with sync_playwright() as p:
    b = p.chromium.launch(args=["--disable-dev-shm-usage", "--disable-gpu", "--headless=old"])
    page = b.new_context(viewport={"width": 1440, "height": 900}).new_page()
    page.goto(BASE + "/", wait_until="load", timeout=60000); page.wait_for_timeout(6000)
    for i, text in enumerate(lines, 1):
        t0 = time.time(); before = len(page.evaluate(BUB))
        page.fill("#message", text); page.wait_for_timeout(300)
        if page.evaluate("document.querySelector('.send-btn')?.getAttribute('data-mode')") == "send": page.click(".send-btn")
        else: page.keyboard.press("Enter")
        page.wait_for_timeout(3000); stable = 0; prev = None
        while time.time() - t0 < 240:
            page.wait_for_timeout(2000)
            bs = page.evaluate(BUB); sig = json.dumps([x["txt"] for x in bs])
            busy = page.evaluate("!!document.querySelector('.send-btn[data-mode=\"stop\"], .send-btn[data-mode=\"cancel\"]')")
            if sig == prev and not busy: stable += 1
            else: stable = 0
            prev = sig
            if stable >= 3: break
        bs = page.evaluate(BUB); new = bs[before:] if len(bs) >= before else bs
        st = state(); e = (st.get("premiere") or {}).get("entrance") or {}
        page.screenshot(path=f"{RUN}/shots/a9_{i:02d}.png")
        txt = "\n".join(x["txt"] for x in new)
        log(json.dumps({"i": i, "msg": text[:60], "secs": round(time.time() - t0), "phase": st.get("phase"), "stage": e.get("stage"), "idx": e.get("index"), "inside": e.get("arrivedNames"), "just": (e.get("justArrived") or {}).get("name"), "ds": st.get("daySchedule"), "tod": (st.get("ceremony") or {}).get("timeOfDay") or st.get("timeOfDay"), "bubble": txt[:700]}))
    b.close()
log("DONE")
