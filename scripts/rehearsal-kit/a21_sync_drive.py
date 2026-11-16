"""ORW-506: the card-aware, toast-synchronised hang-out driver (a9drive.py's successor for the A21b / hang-out scripts). Plays a script through the REAL chat UI
(headless Chromium) against an ALREADY STAGED rig run, like a9drive.py, but:
  - CARD-AWARE: before every message, any decision card on screen is answered in the UI (the simplest legal option, sync_lib.pick_for_card) instead of free-typing past it;
  - TOAST-SYNCHRONISED: a `@toast <text>` script line is sent only when the engine says the player's toast slot is NOW (it sends `next` until then, bounded), never at a fixed position.

  python3 a21_sync_drive.py RUN [--max-messages 60] [--max-cards 12] [--max-toast-nexts 12] [--token rehlocal]

RUN/script.txt is the script (see sync_lib.py for the format). Logs one JSON line per message to RUN/a21sync.log and a final DONE/ABORT line. HARD BOUNDS: --max-messages (ceiling 120)
counts every message sent and every card answered; the wrapper a21-sync-run.sh puts the run under the RIG_SPEND_CAP guard. Never starts a service; never reads a key.
"""
import argparse, json, os, shlex, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sync_lib  # noqa: E402

MAX_MESSAGES_CEILING = 120
BUB = """() => [...document.querySelectorAll('#chat-history .msg-ai')].map(el => { const c = el.cloneNode(true);
  c.querySelectorAll('.thinking-content,.thinking,[class*=thinking],.msg-footer').forEach(n=>n.remove());
  return {txt:(c.innerText||'').trim(), done:!!el.querySelector('.msg-footer')}; })"""
BUSY_JS = "!!document.querySelector('.send-btn[data-mode=\"streaming\"]')"


def slot_value(run, key, default):
    """The run's own slot.env wins; a stray exported variable that DISAGREES with it is a refusal (never drive the other rig)."""
    rec = None
    try:
        for ln in open(os.path.join(run, "slot.env")):
            k, _, v = ln.strip().partition("=")
            if k == key and v:
                rec = shlex.split(v)[0]
    except OSError:
        pass
    env = os.environ.get(key)
    if rec and env and env != rec:
        sys.exit(f"FATAL: {key}={env} disagrees with this run's slot.env ({rec}); refusing to drive the wrong rig")
    return rec or env or default


def clamp_messages(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return 60
    return max(1, min(MAX_MESSAGES_CEILING, n))


class Rig:
    def __init__(self, engine, token):
        self.engine, self.h = engine, {"content-type": "application/json", "authorization": f"Bearer {token}"}

    def call(self, name, args=None):
        r = urllib.request.Request(self.engine + "/player/call", data=json.dumps({"name": name, "args": args or {}}).encode(), headers=self.h, method="POST")
        try:
            return json.load(urllib.request.urlopen(r, timeout=60)).get("result")
        except (urllib.error.URLError, OSError, ValueError):
            return None

    def entrance(self):
        r = self.call("premiereIntros")
        return (r or {}).get("entrance") if isinstance(r, dict) else None

    def state(self):
        return self.call("getGameState") or {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run"); ap.add_argument("--max-messages", type=int, default=60); ap.add_argument("--max-cards", type=int, default=12)
    ap.add_argument("--max-toast-nexts", type=int, default=12); ap.add_argument("--token", default="rehlocal")
    a = ap.parse_args()
    run = a.run
    base = slot_value(run, "RIG_BASE", "http://127.0.0.1:17000"); engine = slot_value(run, "RIG_ENGINE_URL", "http://127.0.0.1:18765")
    script = sync_lib.parse_script(open(f"{run}/script.txt").read())
    cap_msgs = clamp_messages(a.max_messages)
    os.makedirs(f"{run}/shots", exist_ok=True)
    out = open(f"{run}/a21sync.log", "a")

    def log(o):
        out.write((o if isinstance(o, str) else json.dumps(o, default=str)) + "\n"); out.flush()
    from playwright.sync_api import sync_playwright
    rig = Rig(engine, a.token)
    sent = cards = 0
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--disable-dev-shm-usage", "--disable-gpu", "--headless=old"])
        page = b.new_context(viewport={"width": 1440, "height": 900}).new_page()
        page.goto(base + "/", wait_until="load", timeout=60000); page.wait_for_timeout(6000)

        def settle(t0, before, limit=240):
            page.wait_for_timeout(3000); stable, prev = 0, None
            while time.time() - t0 < limit:
                page.wait_for_timeout(2000)
                bs = page.evaluate(BUB); sig = json.dumps([x["txt"] for x in bs]); busy = page.evaluate(BUSY_JS)
                stable = stable + 1 if (sig == prev and not busy) else 0; prev = sig
                if stable >= 3: break
            bs = page.evaluate(BUB)
            return bs[before:] if len(bs) >= before else bs

        def answer_cards():
            """Answer every card on screen (bounded by --max-cards and the shared message bound); True when the screen is clear."""
            nonlocal cards, sent
            for _ in range(6):
                c = page.evaluate(sync_lib.CARD_JS)
                if not c: return True
                if not sync_lib.card_budget_left(cards, a.max_cards) or sent + cards >= cap_msgs:
                    log({"abort": "card budget spent", "cards": cards, "sent": sent, "card": (c.get("title") or "")[:60]}); return False
                me = (rig.state().get("player") or {}).get("name")
                pick = sync_lib.pick_for_card(c, me)
                btns = page.query_selector_all("#orwell-decision-card .odec-opt")
                for i in pick:
                    if i < len(btns): btns[i].click(); page.wait_for_timeout(150)
                ta = page.query_selector("#orwell-decision-card textarea")
                if c.get("hasText") and ta: ta.fill("I will miss you all. Play your own game, and good luck.")
                t0 = time.time(); before = len(page.evaluate(BUB))
                try: page.click("#orwell-decision-card .odec-confirm", timeout=8000)
                except Exception as e: log({"abort": "card Confirm never enabled", "err": repr(e)[:120], "card": c}); return False
                cards += 1
                new = settle(t0, before, 180)
                log({"card": (c.get("title") or "")[:60], "picked": [c["opts"][i] for i in pick if i < len(c["opts"])], "secs": round(time.time() - t0), "bubble": "\n".join(x["txt"] for x in new)[:300]})
            return False

        def send(text, tag):
            nonlocal sent
            if sent + cards >= cap_msgs:
                log({"abort": "message bound reached", "bound": cap_msgs}); return False
            if not answer_cards():
                return False
            t0 = time.time(); before = len(page.evaluate(BUB))
            page.fill("#message", text); page.wait_for_timeout(300)
            if page.evaluate("document.querySelector('.send-btn')?.getAttribute('data-mode')") == "send": page.click(".send-btn")
            else: page.keyboard.press("Enter")
            new = settle(t0, before); sent += 1
            st = rig.state(); e = rig.entrance() or {}
            page.screenshot(path=f"{run}/shots/a21s_{sent:02d}.png")
            log({"i": sent, "tag": tag, "msg": text[:60], "secs": round(time.time() - t0), "phase": st.get("phase"), "stage": e.get("stage"), "playerToast": e.get("playerToast"),
                 "toastRemaining": e.get("toastRemaining"), "ds": st.get("daySchedule"), "bubble": "\n".join(x["txt"] for x in new)[:700]})
            return True

        ok = True
        for entry in script:
            if entry["kind"] == "say":
                ok = send(entry["text"], "say")
            else:
                nexts = 0
                while ok:
                    gate = sync_lib.toast_gate(rig.entrance(), nexts, a.max_toast_nexts)
                    if gate == "send": ok = send(entry["text"], "toast"); break
                    if gate == "skip": log({"toast": "skipped", "nexts": nexts, "entrance": rig.entrance()}); break
                    ok = send("next", "toast-wait"); nexts += 1
            if not ok: break
        answer_cards()
        b.close()
    log("DONE" if ok else "ABORT")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
