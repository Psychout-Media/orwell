#!/usr/bin/env python3
"""ORW-1165: re-issue one closed day's recap for one user as its own "Day N in review" message (ops).

Dry run by default: it prints what it would issue and changes nothing. Pass --apply to issue it. A day that already has a card is never issued twice. The server logs every call.

    ORWELL_INTERNAL_TOKEN=<the app's internal token> \\
      python3 frontend/scripts/reissue_day_recap.py --user <user> --day 1 [--apply] [--base-url http://127.0.0.1:8000]

The route is admin only (POST /api/admin/ops/reissue-day-recap); the token is the app's own ORWELL_INTERNAL_TOKEN, read from the environment and never from the repo.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--user", required=True)
    ap.add_argument("--day", type=int, required=True)
    ap.add_argument("--apply", action="store_true", help="issue the card (default is a dry run)")
    ap.add_argument("--base-url", default=os.environ.get("ORW_BASE_URL", "http://127.0.0.1:8000"))
    args = ap.parse_args(argv)
    token = os.environ.get("ORWELL_INTERNAL_TOKEN")
    if not token:
        print("set ORWELL_INTERNAL_TOKEN (the app's internal token)", file=sys.stderr)
        return 2
    if args.day < 1:
        print("--day must be 1 or more", file=sys.stderr)
        return 2
    body = json.dumps({"user": args.user, "day": args.day, "apply": bool(args.apply)}).encode()
    req = urllib.request.Request(args.base_url.rstrip("/") + "/api/admin/ops/reissue-day-recap", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "X-Orwell-Internal-Token": token})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()[:300]}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"request failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    print(json.dumps(out, indent=2))
    return 0 if out.get("status") in ("issued", "already-issued") or str(out.get("status", "")).startswith("dry-run") else 1


if __name__ == "__main__":
    sys.exit(main())
