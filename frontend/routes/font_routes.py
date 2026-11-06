"""Custom font discovery — lists user-supplied font files in static/fonts/custom/."""
import os
import re
from fastapi import APIRouter

CUSTOM_FONTS_DIR = os.path.join("static", "fonts", "custom")
FONT_EXTENSIONS = {".ttf", ".otf", ".woff", ".woff2"}
FAMILY_SUFFIX_WORDS = ("Display", "Rounded", "Serif", "Sans", "Mono", "Code", "Text")


def _split_family_token(token):
    """Split common compact font-family suffixes without breaking brand names."""
    for suffix in FAMILY_SUFFIX_WORDS:
        if token.endswith(suffix) and len(token) > len(suffix):
            return f"{token[:-len(suffix)]} {suffix}"
    return re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', token)


def _derive_family(filename):
    """Derive a font-family name from a filename like 'JetBrainsMono-Regular.woff2' → 'JetBrains Mono'."""
    name = os.path.splitext(filename)[0]
    # Strip common weight/style suffixes
    name = re.sub(
        r'[-_ ]?(Thin|ExtraLight|UltraLight|Light|Regular|Medium|SemiBold|DemiBold|Bold|ExtraBold|UltraBold|Black|Heavy|Italic|Oblique|Variable|VF)$',
        '', name, flags=re.IGNORECASE
    )
    # Replace dashes/underscores with spaces
    name = re.sub(r'[-_]+', ' ', name).strip()
    name = " ".join(_split_family_token(part) for part in name.split())
    return name or filename


def list_custom_font_families(fonts_dir=None):
    """Group the font files in `fonts_dir` by derived family name. Read-only by design (ORW-152): it
    never creates the directory. On a hardened install the code tree is root-owned and read-only to
    the service, so the old `os.makedirs` raised "Read-only file system" and the endpoint returned a
    500 on every page load. A missing or unreadable directory simply means no custom fonts."""
    fonts_dir = CUSTOM_FONTS_DIR if fonts_dir is None else fonts_dir
    try:
        names = sorted(os.listdir(fonts_dir))
    except OSError:
        return {}
    families = {}
    for f in names:
        ext = os.path.splitext(f)[1].lower()
        if ext not in FONT_EXTENSIONS:
            continue
        family = _derive_family(f)
        if family not in families:
            families[family] = []
        families[family].append({
            "file": f,
            "url": f"/static/fonts/custom/{f}",
            "format": ext.lstrip('.'),
        })
    return families


def setup_font_routes():
    router = APIRouter(prefix="/api/fonts", tags=["fonts"])

    @router.get("/custom")
    async def list_custom_fonts():
        """Return available custom fonts grouped by derived family name."""
        return {"fonts": list_custom_font_families()}

    return router
