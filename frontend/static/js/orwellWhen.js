// ORW-1162: the ONE front-end source for "when is it". Every sidebar panel (the House Status header,
// the premiere block, the time-of-day gadget) reads its words from here, so they can never disagree.
// Inputs are public engine fields only: timeOfDay, earlyMorning, dayNumber, moment, phase, clockLabel,
// daySchedule (headerPhase / next / due) and the premiere projection. Pure; no DOM, no fetch.
(function (root) {
  "use strict";

  const BANDS = {
    "morning": ["\u{1F305}", "Morning"], "afternoon": ["\u{1F31E}", "Afternoon"], "evening": ["\u{1F306}", "Evening"],
    "night": ["\u{1F319}", "Night"], "late-night": ["\u{1F30C}", "Late night"],
  };

  // The part of day: [emoji, label]; past 2am before the wake-up call the engine's earlyMorning flag reads "Early morning" (ORW-392).
  function band(st) {
    const t = st && st.timeOfDay;
    if ((t === "late-night" || t === "morning") && st.earlyMorning === true) return ["\u{1F305}", "Early morning"];
    return BANDS[t] || null;
  }

  function dayOf(st) {
    if (st && Number.isInteger(st.dayNumber)) return st.dayNumber;
    const gs = st && st._state;
    return gs && Number.isInteger(gs.dayNumber) ? gs.dayNumber : null;
  }

  function isNight(st) {
    const t = st && st.timeOfDay;
    return t === "evening" || t === "night" || t === "late-night";
  }

  // The premiere moment: the engine still reports phase or moment "premiere".
  function inPremiere(st) {
    const gs = (st && st._state) || {};
    return !!(st && (st.phase === "premiere" || st.moment === "premiere" || gs.moment === "premiere" || gs.phase === "premiere"));
  }

  // The header names the CURRENT phase. Before the first HOH starts, the engine's headerPhase names the upcoming
  // comp; while the premiere is still the moment (and the comp is not due) the current phase is the premiere.
  function headerPhase(st) {
    const ds = st && st._state && st._state.daySchedule;
    const eng = (ds && typeof ds.headerPhase === "string" && ds.headerPhase) || (st && st.phase);
    if (eng === "hoh-competition" && inPremiere(st) && !(ds && ds.due)) return "premiere";
    return eng;
  }

  // The premiere block's title follows the day: "Move-in night" only on the move-in night.
  function premiereTitle(st) {
    const day = dayOf(st);
    if (day !== null && day >= 2) {
      const t = st && st.timeOfDay;
      return t === "morning" || (st && st.earlyMorning === true) ? "The morning after move-in" : "Before the first HOH";
    }
    if (st && st.timeOfDay && !isNight(st)) return "Move-in day";
    return "Move-in night";
  }

  // The cast face strip retires once everyone is met and the circle has closed (from Day 2 on the circle is over by definition).
  function showCastStrip(st) {
    const prem = st && st.premiere;
    if (!prem || typeof prem !== "object") return false;
    const allMet = prem.complete === true || (Array.isArray(prem.met) && prem.met.length > 0 && Array.isArray(prem.remaining) && prem.remaining.length === 0);
    const cc = prem.champagneCircle;
    const closed = cc === "closed" || !!(cc && typeof cc === "object" && (cc.closed === true || cc.state === "closed"));
    const day = dayOf(st);
    return !(allMet && (closed || (day !== null && day >= 2)));
  }

  const api = { band, dayOf, isNight, inPremiere, headerPhase, premiereTitle, showCastStrip };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.OrwellWhen = api;
})(typeof window !== "undefined" ? window : null);
