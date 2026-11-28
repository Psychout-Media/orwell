"""ORW-1011 C3: build the labelled plan-commit corpus (synthetic player lines, fixed seed, no prod text). Writes tests/fixtures/orw1011_c3_corpus.json.

Row: {id, cls, text, view:{present:[ids], asleep:[ids], here}, exp:{scene:[ids]|null, moves:[[id,room]]}, belt:bool}
`belt` is true when the after-the-prose belts would have fired on the turn (an in-fiction scene with someone awake in the room): the denominator of the belt share.
Classes starting `s1128` are the labelled shapes of the 2026-11-28 prod session (codes only: scene with a named person, scene with an unnamed group, scene plus a
houseguest walking, an out-of-character line, a player-only move), re-voiced with invented names."""
import json
import os
import random

CAST = [("npc:1", "Dana Park"), ("npc:2", "Levi Stone"), ("npc:3", "Maeve Ortiz"), ("npc:4", "Theo Brandt"),
        ("npc:5", "Ines Cole"), ("npc:6", "Rafa Quinn"), ("npc:7", "Nell Ashby"), ("npc:8", "Gus Lindholm")]
ROOMS = [("kitchen", "the kitchen"), ("backyard", "the backyard"), ("lounge", "the lounge"), ("hallway", "the hallway"), ("bathroom", "the bathroom"), ("dining-room", "the dining room")]
HERE = ["living-room", "kitchen", "backyard", "lounge", "hallway"]
R = random.Random(1011)
rows = []


def first(n):
    return n.split()[0]


def pick(k, excl=()):
    return R.sample([c for c in CAST if c[0] not in excl], k)


def add(cls, text, present, exp_scene, moves=(), belt=None, asleep=()):
    here = R.choice(HERE)
    rows.append({"id": f"{cls}-{sum(1 for r in rows if r['cls'] == cls) + 1:02d}", "cls": cls, "text": text,
                 "view": {"present": [p[0] if isinstance(p, tuple) else p for p in present], "asleep": list(asleep), "here": here},
                 "exp": {"scene": exp_scene, "moves": [list(m) for m in moves]},
                 "belt": bool(exp_scene) if belt is None else belt})


ONE = ["I pull {A} aside and ask how {A} is really feeling about this week.", "I tell {A} I have {A}'s back if the vote gets ugly.", "I lean over to {A} and whisper that I do not trust the others.",
       "I ask {A} whether we can be a team for the rest of the season.", "I joke with {A} about the awful coffee and we laugh for a while.", "I confront {A} about the rumor going around the house.",
       "I tell {A} that I admire how {A} plays the game.", "I apologize to {A} for what I said yesterday.", "I tell {A} I will never put {A} on the block.",
       "I ask {A} who {A} would take to the end.", "I sit next to {A} and talk about home for a bit.", "I tell {A} the group chat is getting out of hand."]
for i in range(40):
    a, = pick(1)
    add("talk-named-one", ONE[i % len(ONE)].format(A=first(a[1])), [a] + pick(R.choice([0, 1, 2]), (a[0],)), [a[0]])
TWO = ["I sit with {A} and {B} and pitch a plan to stay safe this week.", "I tell {A} and {B} that the three of us should stick together.",
       "I ask {A} and {B} what they heard about the nominations talk.", "I huddle up with {A} and {B} and we trade stories about our families."]
for i in range(20):
    a, b = pick(2)
    add("talk-named-two", TWO[i % len(TWO)].format(A=first(a[1]), B=first(b[1])), [a, b] + pick(R.choice([0, 1]), (a[0], b[0])), [a[0], b[0]])
SOLO = ["I say we should team up this week.", "I tell them I am worried about my standing in the house.", "I ask how the last few days have been for them.",
        "I admit I have been quiet and ask for advice.", "I offer to share my snacks if they hear anything about the vote."]
for i in range(20):
    a, = pick(1)
    add("talk-unnamed-solo", SOLO[i % len(SOLO)], [a], [a[0]])
GROUP = ["I tell everyone I am done with the drama.", "I announce that I want a quiet night with no gossip.", "I ask the room who is up for a game later.",
         "I say loudly that I think someone here is lying to all of us.", "I propose that we all agree not to target each other."]
for i in range(20):
    g = pick(R.choice([3, 4]))
    # ORW-1170: a line to everyone is a group scene with the people present (up to four); the other group lines name no addressee and stay empty
    add("talk-unnamed-group", GROUP[i % len(GROUP)], g, [x[0] for x in g] if GROUP[i % len(GROUP)].startswith("I tell everyone") and len(g) <= 4 else None, belt=True)
OOC = ["((can you speed up the clock a little))", "(brb two minutes)", "[ooc] how many houseguests are left", "((is there a way to save my place))", "ooc: that last reply was too long",
       "((pause the story for a second please))", "(ignore the last message, wrong window)", "((what does the red icon mean))"]
for i in range(20):
    g = pick(R.choice([1, 2, 3]))
    add("ooc", OOC[i % len(OOC)], g, None, belt=False)
Q = ["What day is it?", "Who is head of household right now?", "How many people are in the house?", "What time is it?", "Is the veto ceremony today?"]
for i in range(10):
    g = pick(R.choice([2, 3]))
    add("production-question", Q[i % len(Q)], g, None, belt=False)
MV = ["I walk to {R}.", "I head over to {R} to clear my head.", "I go into {R} and look around.", "I step out to {R} for some air."]
for i in range(20):
    g = pick(R.choice([1, 3]))
    ro = R.choice(ROOMS)
    add("move-only", MV[i % len(MV)].format(R=ro[1]), g, None, belt=False)
for i in range(10):
    a, b = pick(2)
    add("asleep-named", f"I whisper to {first(a[1])} to check whether {first(a[1])} is awake.", [a, b], None, belt=False, asleep=[a[0], b[0]])
ABS = ["I tell {B} I want to talk later.", "I say {B} should come find me.", "I mutter that {B} has been avoiding me."]
for i in range(10):
    a, b = pick(2)
    add("absent-named", ABS[i % len(ABS)].format(B=first(b[1])), [a], None, belt=True)
TM = ["I ask {A} to go to {R} so we can talk in private.", "I tell {A} to head to {R} and wait for me.", "I invite {A} to walk with me to {R}.", "I ask {A} to meet me in {R}."]
for i in range(25):
    a, = pick(1)
    ro = R.choice([r for r in ROOMS])
    add("talk-and-move", TM[i % len(TM)].format(A=first(a[1]), R=ro[1]), [a] + pick(R.choice([0, 1]), (a[0],)), [a[0]], moves=[(a[0], ro[0])])
for i in range(10):
    a, = pick(1)
    ro = R.choice(ROOMS)
    add("talk-and-move", f"{first(a[1])}, go check on things in {ro[1]} and come back.", [a], [a[0]], moves=[(a[0], ro[0])])
T3 = ["I tell {A} that {B} is lying about the alliance.", "I warn {A} that {B} is gunning for {A}.", "I tell {A} I heard {B} bad-mouthing {A} to the others.", "I ask {A} what {A} really thinks of {B}."]
for i in range(15):
    a, b = pick(2)
    add("third-party", T3[i % len(T3)].format(A=first(a[1]), B=first(b[1])), [a], [a[0]])
FUT = ["I tell {A} I might head to {R} later tonight.", "I tell {A} I was in {R} earlier and it was freezing.", "I tell {A} I never go to {R} anymore."]
for i in range(10):
    a, = pick(1)
    ro = R.choice(ROOMS)
    add("mention-room-no-move", FUT[i % len(FUT)].format(A=first(a[1]), R=ro[1]), [a], [a[0]])
# 11-28 shapes (codes only)
for i in range(6):
    a, = pick(1)
    add("s1128-scene-named", R.choice(ONE).format(A=first(a[1])), [a] + pick(R.choice([1, 2, 3]), (a[0],)), [a[0]])
for i in range(4):
    g = pick(4)
    gt = R.choice(GROUP)
    add("s1128-scene-group", gt, g, [x[0] for x in g] if gt.startswith("I tell everyone") and len(g) <= 4 else None, belt=True)
for i in range(4):
    a, = pick(1)
    ro = R.choice(ROOMS)
    add("s1128-scene-and-walk", R.choice(TM).format(A=first(a[1]), R=ro[1]), [a] + pick(2, (a[0],)), [a[0]], moves=[(a[0], ro[0])])
for i in range(3):
    add("s1128-ooc", R.choice(OOC), pick(3), None, belt=False)
for i in range(3):
    add("s1128-player-move", R.choice(MV).format(R=R.choice(ROOMS)[1]), pick(3), None, belt=False)
# ORW-1170: group shapes whose addressee comes from engine-known context (a private-talk lock, an open ask for a private word, the last scene's partner, the one houseguest who
# spoke last turn). Extra view keys: lock, talk_ask, last_partner, prev. Codes and invented names only.
UNNAMED = ["I tell you I have your back no matter what happens this week.", "I ask you honestly what you think of the plan.", "I lower my voice and say I do not trust the others.",
           "I tell you that you are the only one I would take to the end.", "I say sorry for how I handled yesterday.", "I ask you who you are voting for.",
           "I laugh and tell you that is the best story I have heard here.", "I promise you I will keep this between us.", "I tell you I need your help with something.",
           "I answer that I am not sure yet and ask you what you would do."]
SPEAK = ['{S} leaned in. "Are you really going to trust them with this?" {S} asked, glancing at the door.', '"We need to talk about the vote," {S} said quietly, and waited for an answer.',
         '{S} crossed the room. "What did you hear this morning?" {S} whispered.', '"I am not sure about any of this," {S} admitted, looking at the player.',
         '{S} smiled thinly and said, "So what is your plan?"', '"You never told me where you stand," {S} murmured.']
NOSPEAK = ['The room was quiet. Nell Ashby stirred the coffee and the others picked at their food.', 'Wind moved through the yard and nobody said much of anything.']
BROAD = ["I tell everyone I am done playing games this week.", "I tell everybody that I will not be pushed around.", "I say to all of you that the vote is not decided.",
         "I tell you guys I want an honest week from now on.", "I tell you all that I am proud of how we have played."]
OTHER = ["I tell {B} I have {B}'s back this week.", "I ask {B} what {B} thinks of the plan.", "I thank {B} for the earlier help and say it meant a lot.", "I whisper to {B} that we should stay close."]


def addg(cls, text, present, exp, **ctx):
    here = R.choice(HERE)
    v = {"present": [x[0] for x in present], "asleep": [], "here": here}
    v.update(ctx)
    rows.append({"id": f"{cls}-{sum(1 for r in rows if r['cls'] == cls) + 1:02d}", "cls": cls, "text": text, "view": v,
                 "exp": {"scene": exp, "moves": []}, "belt": bool(exp)})


for i in range(8):
    a, = pick(1)
    addg("grp-lock", UNNAMED[i], [a] + pick(R.choice([2, 3, 5]), (a[0],)), [a[0]], lock=a[0])
for i in range(4):
    a, = pick(1)
    addg("grp-talkask", UNNAMED[i + 2], [a] + pick(3, (a[0],)), [a[0]], talk_ask=a[0])
for i in range(6):
    a, = pick(1)
    addg("grp-lastpartner", UNNAMED[(i * 3) % len(UNNAMED)], [a] + pick(R.choice([2, 4, 6]), (a[0],)), [a[0]], last_partner=a[0])
for i in range(6):
    a, = pick(1)
    addg("grp-speaker", UNNAMED[(i + 5) % len(UNNAMED)], [a] + pick(R.choice([2, 3, 5]), (a[0],)), [a[0]], prev=SPEAK[i].format(S=first(a[1])))
for i in range(3):
    addg("grp-no-context", UNNAMED[i], pick(4), None, prev=NOSPEAK[i % 2])
for i in range(5):
    addg("grp-broadcast", BROAD[i], pick(R.choice([2, 3, 4])), None, last_partner=None)
    rows[-1]["exp"]["scene"] = list(rows[-1]["view"]["present"])
for i in range(4):
    a, b = pick(2)
    addg("grp-named-overrides", OTHER[i].format(B=first(b[1])), [a, b] + pick(2, (a[0], b[0])), [b[0]], last_partner=a[0])
for i in range(3):
    a, b = pick(2)
    addg("grp-conflict", UNNAMED[i + 4], [a, b] + pick(2, (a[0], b[0])), None, last_partner=a[0], prev=SPEAK[i].format(S=first(b[1])))
for i in range(3):
    a, = pick(1)
    rows.append({"id": f"grp-ooc-{i + 1:02d}", "cls": "grp-ooc", "text": OOC[i], "view": {"present": [a[0]] + [x[0] for x in pick(3, (a[0],))], "asleep": [], "here": R.choice(HERE), "lock": a[0]},
                 "exp": {"scene": None, "moves": []}, "belt": False})
for i in range(3):
    a, = pick(1)
    rows.append({"id": f"grp-player-move-{i + 1:02d}", "cls": "grp-player-move", "text": MV[i].format(R=R.choice(ROOMS)[1]), "view": {"present": [a[0]] + [x[0] for x in pick(3, (a[0],))], "asleep": [], "here": R.choice(HERE), "last_partner": a[0]},
                 "exp": {"scene": None, "moves": []}, "belt": False})
out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tests", "fixtures", "orw1011_c3_corpus.json")
json.dump({"cast": CAST, "rows": rows}, open(out, "w"), indent=1)
print(len(rows), "rows ->", out)
