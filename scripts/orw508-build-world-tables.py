#!/usr/bin/env python3
"""ORW-508: derive the compact world tables from two public-domain US government files.

Inputs (fetched once by hand, not by the build; pass the paths):
  --places  Census Bureau Population Estimates, cities and towns, vintage 2023:
            https://www2.census.gov/programs-surveys/popest/datasets/2020-2023/cities/totals/sub-est2023.csv
  --oews    Bureau of Labor Statistics Occupational Employment and Wage Statistics, national, May 2023:
            https://www.bls.gov/oes/special-requests/oesm23nat.zip   (the xlsx inside)
  --names   SSA national baby-name counts by year of birth, sex and name (the yearly yobYYYY.txt files combined into one
            name,year,sex,count CSV), as mirrored by the jsvine/babynames repository (data/name-counts.csv, births 1880
            to 2012; the SSA site itself refused a generic client with 403). Public domain. Checked against the SSA's own
            published 2012 top names (Sophia, Emma, Isabella, Olivia, Ava; Jacob, Mason, Ethan, Noah, William) and the 1990
            count for Michael (65,270).
  --surnames US Census Bureau 2010 Census surnames (names.zip, Names_2010Census.csv), fetched once from
            https://www2.census.gov/topics/genealogy/2010surnames/names.zip . Public domain. Smith is 2,442,977 as published.
Outputs (committed): src/engine/data/world/places.json, jobs.json, given-names.json, surnames.json
Only the standard library is used (the xlsx is read as zip plus xml).
"""
import argparse, csv, json, re, sys, zipfile
import xml.etree.ElementTree as ET

STATES = {"01":"AL","02":"AK","04":"AZ","05":"AR","06":"CA","08":"CO","09":"CT","10":"DE","11":"DC","12":"FL","13":"GA","15":"HI","16":"ID","17":"IL","18":"IN","19":"IA","20":"KS","21":"KY","22":"LA","23":"ME","24":"MD","25":"MA","26":"MI","27":"MN","28":"MS","29":"MO","30":"MT","31":"NE","32":"NV","33":"NH","34":"NJ","35":"NM","36":"NY","37":"NC","38":"ND","39":"OH","40":"OK","41":"OR","42":"PA","44":"RI","45":"SC","46":"SD","47":"TN","48":"TX","49":"UT","50":"VT","51":"VA","53":"WA","54":"WV","55":"WI","56":"WY"}
TYPE_WORDS = r"(city|town|village|borough|municipality|city and borough|corporation|plantation|comunidad|zona urbana)"

def place_name(raw):
    n = re.sub(r"\s*\((balance|pt\.)\)", "", raw)          # "Nashville-Davidson metropolitan government (balance)"
    n = re.sub(r"\s+(metropolitan|metro|consolidated|unified|urban) government.*$", "", n, flags=re.I)
    n = re.sub(r"/.*$", "", n) if "County" in n else n       # "Louisville/Jefferson County metro government"
    n = re.sub(r"\s+" + TYPE_WORDS + r"$", "", n, flags=re.I)
    return n.strip()

def places(path, min_pop):
    best = {}
    with open(path, newline="", encoding="latin-1") as f:
        for r in csv.DictReader(f):
            if r["SUMLEV"] != "162" or r["STATE"] not in STATES: continue
            pop = int(r["POPESTIMATE2023"] or 0)
            if pop < min_pop: continue
            key = (place_name(r["NAME"]), STATES[r["STATE"]])
            if not key[0] or (key in best and best[key] >= pop): continue
            best[key] = pop
    return sorted(([n, s, p] for (n, s), p in best.items()), key=lambda x: (-x[2], x[0], x[1]))

# Birth-year buckets for adults 21 to 60 in a 2026 season (born 1966 to 2005), by decade of birth.
DECADES = [(1966, 1975), (1976, 1985), (1986, 1995), (1996, 2005)]
NAME_MIN_COUNT = 1500  # a name enters the table when it reaches this many births (one sex) in any one decade

def given_names(path):
    counts = {}  # (sex, name) -> [per-decade counts]
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            y = int(r["year"])
            d = next((i for i, (a, b) in enumerate(DECADES) if a <= y <= b), None)
            n = r["name"]
            if d is None or not re.fullmatch(r"[A-Z][a-z]{2,11}", n): continue
            counts.setdefault((r["sex"], n), [0] * len(DECADES))[d] += int(r["count"])
    out = {"F": [], "M": []}
    for (sex, n), c in counts.items():
        if max(c) >= NAME_MIN_COUNT: out[sex].append([n] + c)
    for sex in out: out[sex].sort(key=lambda r: (-sum(r[1:]), r[0]))
    return out

SURNAME_MIN_COUNT = 7000  # about 5,000 surnames, 60 percent of residents
_ODD = re.compile(r"^O(BRIEN|CONNOR|DONNELL|NEIL|NEAL|CONNELL|BRYANT|HARA|ROURKE|LEARY|REILLY|SULLIVAN|KEEFE|BANNON)$")

def surnames(path):
    out = []
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if not r["count"].isdigit() or int(r["count"]) < SURNAME_MIN_COUNT: continue
            n = r["name"]
            if not re.fullmatch(r"[A-Z]{3,12}", n) or _ODD.match(n): continue  # one plain word: no apostrophes, hyphens or spaces
            t = n.title()
            if re.match(r"^Mc[a-z]{3,}$", t): t = "Mc" + t[2:].capitalize()
            out.append([t, int(r["count"])])
    return out

def xlsx_rows(zpath):
    z = zipfile.ZipFile(zpath); inner = zipfile.ZipFile(z.open([n for n in z.namelist() if n.endswith(".xlsx")][0]))
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    ss = ["".join(t.text or "" for t in si.iter("{%s}t" % ns["m"])) for si in ET.fromstring(inner.read("xl/sharedStrings.xml")).findall("m:si", ns)]
    sheet = [n for n in inner.namelist() if n.startswith("xl/worksheets/sheet")][0]
    for r in ET.fromstring(inner.read(sheet)).iter("{%s}row" % ns["m"]):
        row = {}
        for c in r.findall("m:c", ns):
            v = c.find("m:v", ns)
            if v is not None: row[re.match(r"[A-Z]+", c.get("r")).group(0)] = ss[int(v.text)] if c.get("t") == "s" else v.text
        yield row

# Titles that read as a person's job once singularised. Anything with a list, an exception or "all other" is
# skipped unless it is in this authored map (the 40 or so biggest ones that are worded stiffly).
NAMED = {
 "Home Health and Personal Care Aides": "home health aide", "Fast Food and Counter Workers": "fast-food cook", "General and Operations Managers": "operations manager",
 "Laborers and Freight, Stock, and Material Movers, Hand": "warehouse worker", "Waiters and Waitresses": "server", "Janitors and Cleaners, Except Maids and Housekeeping Cleaners": "janitor",
 "Heavy and Tractor-Trailer Truck Drivers": "long-haul trucker", "Light Truck Drivers": "delivery driver", "Sales Representatives, Wholesale and Manufacturing, Except Technical and Scientific Products": "sales rep",
 "Secretaries and Administrative Assistants, Except Legal, Medical, and Executive": "administrative assistant", "Customer Service Representatives": "customer service rep",
 "Office Clerks, General": "office clerk", "Nursing Assistants": "nursing assistant", "Licensed Practical and Licensed Vocational Nurses": "licensed practical nurse",
 "Maintenance and Repair Workers, General": "maintenance technician", "Bookkeeping, Accounting, and Auditing Clerks": "bookkeeper", "Accountants and Auditors": "accountant",
 "Software Developers": "software developer", "Teaching Assistants, Except Postsecondary": "teaching assistant", "Elementary School Teachers, Except Special Education": "elementary school teacher",
 "Secondary School Teachers, Except Special and Career/Technical Education": "high-school teacher", "Middle School Teachers, Except Special and Career/Technical Education": "middle-school teacher",
 "Kindergarten Teachers, Except Special Education": "kindergarten teacher", "Preschool Teachers, Except Special Education": "preschool teacher", "Coaches and Scouts": "coach",
 "Bartenders": "bartender", "Cooks, Restaurant": "line cook", "Cooks, Fast Food": "fast-food cook", "Hairdressers, Hairstylists, and Cosmetologists": "hairstylist",
 "Heating, Air Conditioning, and Refrigeration Mechanics and Installers": "HVAC technician", "Automotive Service Technicians and Mechanics": "auto mechanic",
 "Electricians": "electrician", "Plumbers, Pipefitters, and Steamfitters": "plumber", "Carpenters": "carpenter", "Firefighters": "firefighter", "Police and Sheriff's Patrol Officers": "police officer",
 "Emergency Medical Technicians": "EMT", "Paramedics": "paramedic", "Software Quality Assurance Analysts and Testers": "QA tester", "Computer User Support Specialists": "IT support specialist",
 "Network and Computer Systems Administrators": "network administrator", "Web Developers": "web developer", "Graphic Designers": "graphic designer", "Photographers": "photographer",
 "Musicians and Singers": "musician", "Actors": "actor", "Fitness Trainers and Aerobics Instructors": "fitness instructor", "Flight Attendants": "flight attendant",
 "Real Estate Sales Agents": "real-estate agent", "Insurance Sales Agents": "insurance agent", "Financial and Investment Analysts": "financial analyst", "Loan Officers": "loan officer",
 "Social and Human Service Assistants": "social services assistant", "Child, Family, and School Social Workers": "social worker", "Medical Assistants": "medical assistant",
 "Dental Assistants": "dental assistant", "Pharmacy Technicians": "pharmacy technician", "Massage Therapists": "massage therapist", "Veterinary Technologists and Technicians": "vet tech",
 "Farmers, Ranchers, and Other Agricultural Managers": "farmer", "Landscaping and Groundskeeping Workers": "landscaper", "Construction Laborers": "construction laborer",
 "Welders, Cutters, Solderers, and Brazers": "welder", "Bus Drivers, School": "school bus driver", "Taxi Drivers": "taxi driver", "Postal Service Mail Carriers": "postal carrier",
 "Librarians and Media Collections Specialists": "librarian", "Chefs and Head Cooks": "chef", "Bakers": "baker", "Butchers and Meat Cutters": "butcher", "Baristas": "barista",
 "Coaches and Scouts ": "coach", "Athletes and Sports Competitors": "pro athlete", "Dancers": "dancer", "Writers and Authors": "writer", "Editors": "editor", "Reporters and Correspondents": "reporter",
 "Public Relations Specialists": "publicist", "Fashion Designers": "fashion designer", "Interior Designers": "interior designer", "Barbers": "barber", "Manicurists and Pedicurists": "nail technician",
 "Tattoo Artists": "tattoo artist", "Animal Trainers": "animal trainer", "Pilots, Ship": "ship pilot", "Commercial Pilots": "commercial pilot", "Airline Pilots, Copilots, and Flight Engineers": "airline pilot",
}
SKIP_CODES = {"11-1011","11-1031","23-1023","23-1021","11-1021x"}  # chief executives, legislators, judges: real people's offices, not a casting pool
CASTABILITY = {"11":0.5,"13":0.8,"15":1.0,"17":0.8,"19":0.6,"21":1.0,"23":0.4,"25":1.0,"27":2.5,"29":1.0,"31":1.0,"33":0.8,"35":1.5,"37":0.5,"39":1.8,"41":1.2,"43":0.5,"45":0.8,"47":1.0,"49":1.0,"51":0.4,"53":0.7}
MIN_AGE_GROUP = {"11":27,"13":24,"15":22,"17":23,"19":24,"21":24,"23":26,"25":23,"29":23}
MIN_AGE_CODE = {"29-12":27,"29-1051":27,"29-1021":27,"29-1131":26,"29-1171":27,"53-2":23,"23-1011":26}
FARM = re.compile(r"farm|ranch|agricultur|logging|forest|fishing|hunting|crop|animal breeder", re.I)

def singular(word):
    w = word
    if re.search(r"ies$", w): return w[:-3] + "y"
    if re.search(r"(ches|shes|xes|sses)$", w): return w[:-2]
    if w.endswith("s") and not re.search(r"(ss|us|is|ics)$", w): return w[:-1]
    return w

def plain(title):
    if title in NAMED: return NAMED[title]
    if re.search(r"all other|miscellaneous|,| and | or |except|\(|/|\bsupervisors\b|\bother\b", title, re.I): return None
    words = title.split()
    if len(words) > 4: return None
    words[-1] = singular(words[-1])
    out = " ".join(words).lower()
    return re.sub(r"\bhvac\b", "HVAC", out)

def min_age(code):
    for k in sorted(MIN_AGE_CODE, key=len, reverse=True):
        if code.startswith(k): return MIN_AGE_CODE[k]
    return MIN_AGE_GROUP.get(code[:2], 0)

def jobs(zpath):
    rows = list(xlsx_rows(zpath)); head = {v: k for k, v in rows[0].items()}
    out = {}
    for r in rows[1:]:
        if r.get(head["O_GROUP"]) != "detailed": continue
        code, title = r[head["OCC_CODE"]], r[head["OCC_TITLE"]]
        if code in SKIP_CODES or code[:2] == "55": continue
        try: emp = int(r.get(head["TOT_EMP"], "0"))
        except ValueError: continue
        name = plain(title)
        if not name or emp <= 0: continue
        w = emp * CASTABILITY.get(code[:2], 1.0)
        row = out.setdefault(name, [name, 0, code, min_age(code), "small-city" if FARM.search(title) else ""])
        row[1] += round(w / 1000)  # weight in thousands of (castability-adjusted) jobs
    return sorted((r for r in out.values() if r[1] > 0), key=lambda r: (-r[1], r[0]))

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--places", required=True); ap.add_argument("--oews", required=True); ap.add_argument("--names", required=True); ap.add_argument("--surnames", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--min-pop", type=int, default=1000)
    a = ap.parse_args()
    p = places(a.places, a.min_pop); j = jobs(a.oews)
    json.dump({"source": "US Census Bureau Population Estimates, cities and towns, vintage 2023 (SUMLEV 162, incorporated places with 1,000 or more residents). Public domain.", "columns": ["name", "state", "population"], "rows": p}, open(a.out + "/places.json", "w"), separators=(",", ":"), ensure_ascii=False)
    json.dump({"source": "US Bureau of Labor Statistics, Occupational Employment and Wage Statistics, national, May 2023, detailed occupations. Weight is employment in thousands times an authored castability lean per major group. Public domain.", "columns": ["job", "weightK", "socCode", "minAge", "maxSize"], "rows": j}, open(a.out + "/jobs.json", "w"), separators=(",", ":"), ensure_ascii=False)
    g = given_names(a.names)
    json.dump({"source": "US Social Security Administration national baby-name counts (births 1966 to 2005 in four decade buckets), via the jsvine/babynames mirror of the SSA yob files. Public domain.", "decades": [list(d) for d in DECADES], "columns": ["name", "count per decade bucket"], "F": g["F"], "M": g["M"]}, open(a.out + "/given-names.json", "w"), separators=(",", ":"))
    sn = surnames(a.surnames)
    json.dump({"source": "US Census Bureau 2010 Census surnames (names with 7,000 or more people, one plain word), about 60 percent of residents. Public domain.", "columns": ["name", "people"], "rows": sn}, open(a.out + "/surnames.json", "w"), separators=(",", ":"))
    print(len(sn), "surnames;", end=" ", file=sys.stderr)
    print(len(p), "places;", len(j), "jobs;", len(g["F"]), "female and", len(g["M"]), "male names", file=sys.stderr)
