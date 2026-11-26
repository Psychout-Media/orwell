"""ORW-563 v2: the cast-level believability judge. ONE batched model call per cast asks, for every card, whether a stranger would find it natural that
someone who looks and dresses like this does this job and lives this life. A card judged a far outlier is re-picked to a plausible free style family
(the judge may name one of the offered candidates) and its clothes are written again from the person. When the call fails or returns junk, the
deterministic check (orwell_cast_realism.believability_look_life) decides instead, and the failure is recorded. At most about a third of a cast is
re-picked in one pass (the lowest-fit flags are kept). Public card text only; no Vault field."""
from __future__ import annotations

import json
import logging
from typing import Optional

logger = logging.getLogger(__name__)

MAX_REPICK_SHARE = 1 / 3
REASON_MAX = 160

JUDGE_RULE = (
    "One question per person: would a stranger who sees this person (the written wardrobe and style, the signature) and reads their card (job, town, "
    "age, personality, background and the interests in the biography) find it natural that someone who looks and dresses like this does this job and "
    "lives this life? Judge only what is actually written and would be shown: the wardrobe, the style line, the signature and the interests. The "
    "dealt look label is context only: a person whose label seems odd but whose written wardrobe and interests are believable for their life is NOT "
    "flagged. The people are characters in a video game, so a look that is 10 to 35 percent typical for the life is an ordinary person: unusual is "
    "fine, individual taste is fine, a quirk is fine, and a person whose taste leans against their job is NOT flagged. Flag a person "
    "ONLY when what is written is so far out of the realm of normalcy for this life that it reads like an error of the generator: the wardrobe, "
    "the style line and the interests together describe a different kind of person than the job, the town, the age and the upbringing allow, with "
    "nothing in the card that explains it. Do not flag a person only because the look matches or does not match a "
    "stereotype of the job. At most a third of the cast may be flagged; the clearest first."
)


def judge_messages(cards: list, candidates: dict) -> list:
    people = []
    for c in cards:
        pc = c.get("physicalCharacteristics") if isinstance(c.get("physicalCharacteristics"), dict) else {}
        people.append({"id": c.get("id"), "job": c.get("vocation"), "town": c.get("hometown"), "age": c.get("age"), "archetype": c.get("archetype"),
                       "demeanor": c.get("demeanor"), "background": c.get("background"), "wardrobe": pc.get("wardrobe"), "style": pc.get("style"),
                       "signature": pc.get("lookSignature"), "interests": " ".join(str(c.get("biography") or "").split())[:360],
                       "labelContextOnly": c.get("presentation"), "candidates": candidates.get(str(c.get("id")), [])})
    system = ("You are the casting director of a reality show checking that every person is believable as a whole person. " + JUDGE_RULE
              + ' Reply with STRICT JSON only: {"flagged": [{"id": "...", "reason": "one short line", "pick": "one of that person\'s candidates, or empty"}]}, '
              'or {"flagged": []}.')
    return [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(people, ensure_ascii=False)}]


def parse_verdict(text, valid_ids: set, candidates: dict) -> Optional[dict]:
    """{id: {"reason": str, "pick": label or None}} from the judge's reply; None when the reply is junk (no JSON object with a "flagged" list).
    Unknown ids and non-dict entries are dropped; a pick that is not one of that person's candidates is dropped (the re-pick chooses)."""
    from src.orwell_cast_authoring import _extract_json
    try:
        obj = _extract_json(text or "") if isinstance(text, str) else None
    except Exception:  # failsoft-ok: junk is a failed judgement, handled by the caller
        return None
    if not isinstance(obj, dict) or not isinstance(obj.get("flagged"), list):
        return None
    out: dict = {}
    for item in obj["flagged"]:
        if not isinstance(item, dict):
            continue
        hid = str(item.get("id") or "")
        if hid not in valid_ids or hid in out:
            continue
        pick = item.get("pick")
        pick = pick.strip() if isinstance(pick, str) and pick.strip() in candidates.get(hid, []) else None
        out[hid] = {"reason": " ".join(str(item.get("reason") or "").split())[:REASON_MAX], "pick": pick}
    return out


def cap_flags(flags: dict, cards_by_id: dict, n: int):
    """Keep the strongest flags (lowest fit weight first) when more than about a third of the cast is flagged. Returns (kept, dropped_count)."""
    from src import orwell_cast_realism as R
    limit = max(1, int(n * MAX_REPICK_SHARE))
    if len(flags) <= limit:
        return dict(flags), 0
    def weight(hid):
        c = cards_by_id[hid]
        from src.orwell_style_families import family_for_label
        fam = family_for_label(str(c.get("presentation") or ""))
        return R.life_fit_weight(fam["id"], c) if fam else 1.0
    keep = sorted(flags, key=lambda h: (weight(h), h))[:limit]
    return {h: flags[h] for h in keep}, len(flags) - limit


def _soft_failure(kind: str, msg: str, user=None) -> None:
    try:
        from src import log_rings
        log_rings.record_soft_failure(f"cast-believability:{kind}", msg, corrected="deterministic-check", user=user)
    except Exception:  # failsoft-ok: the health record must never break authoring
        pass


async def decide_flags(cards: list, taken: set, llm_fn, user=None, stats: Optional[dict] = None):
    """(flags, candidates): flags is {id: {"reason", "pick"}} from ONE model call, else the deterministic check when the call fails or is junk."""
    from src import orwell_cast_realism as R
    cards_by_id = {str(c.get("id")): c for c in cards}
    stats = stats if stats is not None else {}
    candidates = {hid: R.look_candidates(c, taken - {str(c.get("presentation") or "")}) for hid, c in cards_by_id.items()}
    flags = None
    why = ""
    try:
        msgs = judge_messages(cards, candidates)
        stats["calls"] = stats.get("calls", 0) + 1
        stats["chars_in"] = stats.get("chars_in", 0) + sum(len(m["content"]) for m in msgs)
        text = await llm_fn(msgs)
        stats["chars_out"] = stats.get("chars_out", 0) + len(text or "")
        flags = parse_verdict(text, set(cards_by_id), candidates)
        if flags is None:
            why = "the reply was not the expected JSON"
    except Exception as e:  # failsoft-ok: a failed judge falls back to the deterministic check
        why = f"the call failed ({type(e).__name__})"
    if flags is None:
        stats["fallback"] = stats.get("fallback", 0) + 1
        logger.warning(f"[cast-believability] judge unavailable: {why}; using the deterministic check")
        _soft_failure("judge", f"the believability judge gave no usable answer: {why}; the deterministic check decided", user)
        flags = {hid: {"reason": "deterministic outlier", "pick": None} for hid, c in cards_by_id.items() if R.believability_look_life(c)}
    return flags, candidates


async def believability_pass(cards: list, taken: set, llm_fn, write_fn, look_write_fn, user=None, stats: Optional[dict] = None) -> int:
    """Judge the cast once, re-pick the far outliers (capped), rewrite their clothes from the person, store both. Returns the number re-picked.
    A card whose clothes cannot be rewritten is put back on its dealt family, so the label and the look never disagree."""
    from src import orwell_cast_authoring as A
    from src import orwell_cast_realism as R
    stats = stats if stats is not None else {}
    cards = [c for c in cards if c.get("id")]
    if len(cards) < 2:
        return 0
    flags, candidates = await decide_flags(cards, taken, llm_fn, user, stats)
    by_id = {str(c["id"]): c for c in cards}
    flags, dropped = cap_flags(flags, by_id, len(cards))
    stats["flagged"] = stats.get("flagged", 0) + len(flags)
    if dropped:
        stats["capped"] = stats.get("capped", 0) + dropped
        logger.info(f"[cast-believability] {dropped} more flag(s) than a third of the cast: kept the strongest {len(flags)}")
    done = 0
    held = set(taken)
    for hid, fl in flags.items():
        card = by_id[hid]
        old = str(card.get("presentation") or "")
        options = [x for x in R.look_candidates(card, held - {old})]
        new = fl.get("pick") if fl.get("pick") in options else R.repick_look(card, held - {old})
        if not new or new == old:
            continue
        try:
            res = await write_fn({"houseguestId": hid, "presentation": new})
            if not (isinstance(res, dict) and res.get("accepted") and "presentation" in (res.get("publicFields") or [])):
                continue
            phys = card.get("physicalCharacteristics") if isinstance(card.get("physicalCharacteristics"), dict) else {}
            fresh = None
            refused: list = []  # ORW-952: the check code(s) that refused the rewrite, named in the soft-failure
            ask = ("A casting director found this look far from what this person's whole life would own (" + (fl.get("reason") or "it does not fit") + "). "
                   + A.FIT_AUDIT_RULE + " Rewrite the wardrobe (2-3 pieces, one garment each) and a short style line that describes those very clothes in plain "
                   'words and names no style family. Reply with ONLY {"wardrobe": [...], "style": "..."}.')
            obj = A._extract_json(await llm_fn(A.compact_rewrite_messages(card, ask))) or {}
            wd = obj.get("wardrobe")
            wd = [" ".join(str(x).split()) for x in wd if isinstance(x, (str, int)) and str(x).strip()] if isinstance(wd, list) else []
            if not 2 <= len(wd) <= 3:
                refused = ["wardrobe-count"]
            if 2 <= len(wd) <= 3:
                style = " ".join(str(obj.get("style") or "").split()) or ", ".join(x.lower() for x in wd)
                new_look = {k: (R.scrub_labels(v) if isinstance(v, str) else [R.scrub_labels(x) for x in v]) for k, v in {"wardrobe": wd, "style": style}.items()}
                cand = {**card, "presentation": new, "physicalCharacteristics": {**phys, **new_look}}
                lp = A.look_problems(cand, cand)
                fit = [x for x in R.look_fits_life(cand) if x in ("upscale", "climate", "missing")]
                bl = R.believability_look_life(cand)
                if not lp and not fit and not bl:
                    fresh = new_look
                refused = list(lp) + fit + list(bl)
            ok = False
            if fresh is not None:
                lres = await look_write_fn(hid, fresh)
                ok = not (isinstance(lres, dict) and lres.get("accepted") is False)
                if not ok:
                    refused = ["look-write-refused"]
            if ok:
                card["presentation"] = new
                card["physicalCharacteristics"] = {**phys, **fresh}
                held.discard(old)
                held.add(new)
                done += 1
                stats["repicked"] = stats.get("repicked", 0) + 1
            else:
                await write_fn({"houseguestId": hid, "presentation": old})  # put the dealt family back: the label and the clothes agree
                stats["reverted"] = stats.get("reverted", 0) + 1
                why = ",".join(refused) or "none"
                logger.info(f"[cast-believability] clothes rewrite refused for {hid}: {why}")
                _soft_failure("rewrite", f"card {hid} was judged an outlier but its clothes could not be rewritten ({why}); left as dealt", user)
        except Exception as e:  # failsoft-ok: best-effort-enrichment (the dealt look stands)
            logger.warning(f"[cast-believability] re-pick skipped for {hid}: {type(e).__name__}")
            try:
                await write_fn({"houseguestId": hid, "presentation": old})
            except Exception:  # failsoft-ok: the dealt family is still the stored one when this write also fails
                pass
    return done


def stats_line(stats: dict) -> str:
    return ("[cast-believability] season line: judge-calls={calls} judge-chars-in={chars_in} judge-chars-out={chars_out} fallback={fallback} "
            "flagged={flagged} capped={capped} repicked={repicked} reverted={reverted}").format(**{k: stats.get(k, 0) for k in (
                "calls", "chars_in", "chars_out", "fallback", "flagged", "capped", "repicked", "reverted")})
