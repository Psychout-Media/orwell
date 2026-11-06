"""/play: the new React front end, served beside (never instead of) the classic UI.

The app is built by ``cd frontend/web && npm ci && npm run build`` into ``frontend/web/dist``.
This module only SERVES that build: index.html with ``no-cache`` (so a deploy is picked up on the
next load) and the content-hashed files under ``/play/assets/`` with a one-year immutable cache.
It touches no other route, shares the existing session cookie/auth middleware, and changes no
game behaviour. Remove the ``setup_play_routes`` include in app.py to roll it back.
"""
from __future__ import annotations

import gzip
import mimetypes
import os
from typing import Dict, Tuple

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, Response

_IMMUTABLE = "public, max-age=31536000, immutable"
_COMPRESSIBLE = {".js", ".css", ".svg", ".json", ".html", ".map", ".txt"}

_NOT_BUILT = """<!doctype html><meta charset="utf-8"><title>Orwell</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">
<h1>The new interface is not built here yet</h1>
<p>This server has no <code>frontend/web/dist</code>. The classic interface is unaffected.</p>
<p><a href="/">Open the classic interface</a></p>"""


def default_dist_dir() -> str:
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "dist")


def setup_play_routes(dist_dir: str | None = None) -> APIRouter:
    router = APIRouter()
    dist = os.path.realpath(dist_dir or default_dist_dir())
    # (path, mtime_ns) -> gzipped bytes. Hashed assets never change for a given name; the mtime key
    # makes a rebuild-in-place safe too.
    gz_cache: Dict[Tuple[str, int], bytes] = {}

    def _index() -> Response:
        path = os.path.join(dist, "index.html")
        if not os.path.isfile(path):
            return HTMLResponse(_NOT_BUILT, status_code=503, headers={"Cache-Control": "no-store"})
        with open(path, "rb") as fh:
            body = fh.read()
        return Response(
            content=body,
            media_type="text/html; charset=utf-8",
            headers={"Cache-Control": "no-cache", "Vary": "Accept-Encoding"},
        )

    @router.get("/play", include_in_schema=False)
    @router.get("/play/", include_in_schema=False)
    async def play_index() -> Response:
        return _index()

    @router.get("/play/assets/{name:path}", include_in_schema=False)
    async def play_asset(name: str, request: Request) -> Response:
        full = os.path.realpath(os.path.join(dist, "assets", name))
        # Containment: the resolved file must live under dist/assets (no ../ or symlink escape).
        if not full.startswith(os.path.join(dist, "assets") + os.sep) or not os.path.isfile(full):
            raise HTTPException(404, "Not found")
        ext = os.path.splitext(full)[1].lower()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ext in (".js", ".mjs"):
            ctype = "text/javascript"
        headers = {"Cache-Control": _IMMUTABLE, "Vary": "Accept-Encoding"}
        st = os.stat(full)
        wants_gzip = "gzip" in (request.headers.get("accept-encoding") or "").lower()
        if wants_gzip and ext in _COMPRESSIBLE:
            key = (full, st.st_mtime_ns)
            data = gz_cache.get(key)
            if data is None:
                with open(full, "rb") as fh:
                    data = gzip.compress(fh.read(), compresslevel=6, mtime=0)
                gz_cache[key] = data
            headers["Content-Encoding"] = "gzip"
            return Response(content=data, media_type=ctype, headers=headers)
        with open(full, "rb") as fh:
            return Response(content=fh.read(), media_type=ctype, headers=headers)

    return router
