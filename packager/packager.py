#!/usr/bin/env python3
# packager.py
# Creates launchable mini-apps (config + shell + desktop icon) from resources.json
# Requires: requests, beautifulsoup4, pillow, cairosvg (optional but used for SVG)
# Optional: lxml

import os
import sys
import json
import stat
import argparse
import re
from io import BytesIO
from urllib.parse import urlparse, urljoin

import requests
from bs4 import BeautifulSoup
from PIL import Image, ImageDraw, ImageFilter, ImageOps, ImageEnhance, ImageChops, ImageFont, ImageStat

# Try SVG rasterizer
try:
    import cairosvg
    HAS_CAIROSVG = True
except Exception:
    HAS_CAIROSVG = False

# ---------------------------- Config / Defaults ---------------------------- #

REQUEST_KW = dict(
    timeout=8,
    allow_redirects=True,
    headers={"User-Agent": "browserless-packager/1.0 (+https://example.local)"},
)

DEFAULT_INPUT = "resources.json"
DEFAULT_OUTDIR = "generated"

# Sensible defaults; override via CLI
# WadBrowser project root (parent of packager/), so launch.sh runs electron from the right place
_PACKAGER_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PROJECT_DIR = os.path.dirname(_PACKAGER_DIR)
DEFAULT_DESKTOP_DIR = os.path.expanduser("~/Desktop")
DEFAULT_APPS_DIR = os.path.expanduser("~/.local/share/applications")

# Icon canvas
CANVAS_SIZE = 512
CARD_RADIUS = 96
CARD_BORDER = 4  # outer card border width
CARD_BORDER_COLOR = (225, 225, 225, 255)  # subtle soft gray
CARD_FILL = (255, 255, 255, 255)
ICON_SIZE = 480 

# Icon inside card
ICON_MAX = 480  # max inner icon box


# ---------------------------- Utilities ---------------------------- #

def slugify(name: str) -> str:
    s = name.strip().lower()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_-]+", "-", s)
    s = re.sub(r"^-+|-+$", "", s)
    return s or "app"

def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)

def write_executable(path: str, content: str):
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    st = os.stat(path)
    os.chmod(path, st.st_mode | stat.S_IEXEC)

def try_int(x, default=0):
    try:
        return int(x)
    except Exception:
        return default


# ---------------------------- Favicon Fetching ---------------------------- #

def _get_link_tags(page_url: str):
    resp = requests.get(page_url, **REQUEST_KW)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "lxml" if soup_has_lxml() else "html.parser")
    tags = []
    for link in soup.find_all("link", rel=True):
        rels = " ".join(link.get("rel", [])).lower()
        if any(r in rels for r in ("icon", "shortcut icon", "apple-touch-icon", "mask-icon")):
            href = link.get("href")
            sizes = (link.get("sizes") or "").lower()
            if href:
                tags.append((urljoin(page_url, href), sizes, rels))
    return tags

def soup_has_lxml():
    try:
        import lxml  # noqa: F401
        return True
    except Exception:
        return False

def _parse_declared_area(sizes: str) -> int:
    """Return declared pixel area; 'any' => very large."""
    if sizes == "any":
        return 1_000_000_000
    best = 0
    for token in sizes.split():
        if "x" in token:
            w_h = token.lower().split("x")
            if len(w_h) == 2:
                w, h = try_int(w_h[0]), try_int(w_h[1])
                best = max(best, w * h)
    return best

def _measure_bitmap_area(content: bytes) -> tuple[int, str]:
    """Return pixel area and format; 0 area if unreadable."""
    try:
        img = Image.open(BytesIO(content))
        img.load()
        return (img.width * img.height, (img.format or "").lower())
    except Exception:
        return (0, "")

def _rasterize_svg(svg_bytes: bytes, px: int = 1024) -> bytes:
    if not HAS_CAIROSVG:
        return b""
    try:
        out = cairosvg.svg2png(bytestring=svg_bytes, output_width=px, output_height=px)
        return out
    except Exception:
        return b""

def fetch_best_favicon(url: str) -> tuple[bytes, str]:
    """
    Returns (png_bytes, 'png') always.
    Strategy:
      1) collect <link rel=...> icons + /favicon.ico
      2) prefer SVG (rasterize to PNG)
      3) else download largest bitmap by measured area
    """
    parsed = urlparse(url)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    candidates = _get_link_tags(url)

    # Include fallback /favicon.ico
    ico_fallback = f"{origin}/favicon.ico"
    if all(c[0] != ico_fallback for c in candidates):
        candidates.append((ico_fallback, "", "fallback"))

    # 1) SVG direct if found
    for href, sizes, rels in candidates:
        if href.lower().endswith(".svg"):
            r = requests.get(href, **REQUEST_KW)
            if r.ok and "image/svg" in r.headers.get("content-type", "").lower():
                png = _rasterize_svg(r.content, px=1024)
                if png:
                    return (png, "png")

    # 2) Rank by declared sizes desc
    candidates = sorted(candidates, key=lambda t: _parse_declared_area(t[1]), reverse=True)

    best_bytes = b""
    best_area = 0
    best_fmt = ""

    for href, sizes, rels in candidates:
        try:
            r = requests.get(href, **REQUEST_KW)
            if not r.ok:
                continue
            ctype = r.headers.get("content-type", "").lower()
            data = r.content

            # If this is actually an SVG but not labeled above:
            if "image/svg" in ctype or href.lower().endswith(".svg"):
                png = _rasterize_svg(data, px=1024)
                if png:
                    # treat big rasterized SVG as huge
                    area = 1024 * 1024
                    if area > best_area:
                        best_area, best_bytes, best_fmt = area, png, "png"
                continue

            area, fmt = _measure_bitmap_area(data)
            if area > best_area:
                best_area, best_bytes, best_fmt = area, data, fmt
        except Exception:
            continue

    if not best_bytes:
        raise RuntimeError("Could not fetch any favicon")

    # If not PNG, convert to PNG here
    try:
        im = Image.open(BytesIO(best_bytes))
        im.load()
        with BytesIO() as buf:
            im.save(buf, "PNG")
            return (buf.getvalue(), "png")
    except Exception:
        raise RuntimeError("Failed to decode/convert favicon to PNG")


# ---------------------------- Icon Styling ---------------------------- #

def make_card_canvas(size=CANVAS_SIZE, radius=CARD_RADIUS,
                     fill=CARD_FILL, border=CARD_BORDER, border_color=CARD_BORDER_COLOR) -> Image.Image:
    W = H = size
    card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    mask = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([border//2, border//2, W-border//2-1, H-border//2-1],
                           radius=radius, fill=255)
    # Fill
    base = Image.new("RGBA", (W, H), fill)
    card = Image.composite(base, card, mask)
    # Border
    if border > 0:
        bd = ImageDraw.Draw(card)
        bd.rounded_rectangle([border//2, border//2, W-border//2-1, H-border//2-1],
                             radius=radius, outline=border_color, width=border)
    return card

def _resize_to_square(img: Image.Image, size: int) -> Image.Image:
    """
    Resize (keep aspect) then letterbox into an exact square `size`×`size`.
    """
    img = img.convert("RGBA")
    w, h = img.size
    if w == 0 or h == 0:
        return Image.new("RGBA", (size, size), (255, 255, 255, 0))

    scale = min(size / w, size / h)
    new_wh = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
    img_resized = img.resize(new_wh, Image.LANCZOS)

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x = (size - new_wh[0]) // 2
    y = (size - new_wh[1]) // 2
    canvas.alpha_composite(img_resized, dest=(x, y))
    return canvas

def round_corners(img: Image.Image, radius: int) -> Image.Image:
    """Return `img` with rounded-corner alpha."""
    img = img.convert("RGBA")
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, w-1, h-1], radius=radius, fill=255)
    rounded = Image.new("RGBA", (w, h))
    rounded.paste(img, (0, 0), mask)
    return rounded

def process_icon_to_card(png_bytes: bytes) -> Image.Image:
    """
    1) Decode favicon
    2) Grayscale + threshold pop
    3) Add crisp double stroke (black inner, white outer)
    4) Composite on rounded white card
    Returns final 512×512 RGBA.
    """
    # Decode original favicon
    raw = Image.open(BytesIO(png_bytes)).convert("RGBA")
    icon_rgba_96 = _resize_to_square(raw, ICON_SIZE)

    # Flatten favicon transparency to white and round edges
    white_bg = Image.new("RGBA", icon_rgba_96.size, (255, 255, 255, 255))

    # Create a rounded mask
    mask = Image.new("L", icon_rgba_96.size, 0)
    draw = ImageDraw.Draw(mask)
    radius = 16  # Adjust for how round you want the corners
    w, h = icon_rgba_96.size
    draw.rounded_rectangle([0, 0, w, h], radius, fill=255)

    # Composite the favicon with the rounded mask
    icon_rgba_rounded = Image.new("RGBA", icon_rgba_96.size, (0, 0, 0, 0))
    icon_rgba_rounded.paste(icon_rgba_96, (0, 0), mask)

    # Now flatten to white background
    icon_flat = Image.alpha_composite(white_bg, icon_rgba_rounded)

    # --- Grayscale & threshold pass ---
    gray = ImageOps.grayscale(icon_flat)  # now "L" mode
    # Apply threshold to pop darker regions
    # --- Decide if favicon is mostly dark or light ---
    stat = ImageStat.Stat(gray)
    mean_luma = stat.mean[0]  # 0 = black, 255 = white

    # Tune these as needed
    bg_threshold = 128   # what counts as "dark overall"
    cutoff = 200         # what counts as "light pixel"

    if mean_luma < bg_threshold:
        # Mostly dark -> likely dark background with light icon.
        # We want: light -> white, dark -> black
        gray_thresh = gray.point(lambda p: 255 if p > cutoff else 0)
    else:
        # Mostly light -> likely light background with dark icon.
        # We want your original behavior: light -> black, dark -> white
        gray_thresh = gray.point(lambda p: 0 if p > cutoff else 255)

    # Convert to RGBA and fill alpha channel fully
    icon_gray = Image.merge("LA", (gray_thresh, Image.new("L", gray.size, 255))).convert("RGBA")

    # blur to make the edges softer
    icon_gray = icon_gray.filter(ImageFilter.GaussianBlur(radius=1))

    icon_gray = round_corners(icon_gray, radius=int(CARD_RADIUS * (ICON_SIZE / CANVAS_SIZE)))

    # --- Card background ---
    card = make_card_canvas()

    # Center icon
    cw, ch = card.size
    iw, ih = icon_gray.size
    card.alpha_composite(icon_gray, dest=((cw - iw)//2, (ch - ih)//2))

    return card

def process_text_icon_on_card(text: str) -> Image.Image:
    """Create a white card with a black rounded square and centered white text.
    Text example: ":8080".
    Returns a final 512×512 RGBA image.
    """
    # Base card
    card = make_card_canvas()
    draw = ImageDraw.Draw(card)

    # Inner black rounded square
    inset = CANVAS_SIZE - ICON_SIZE - 16 # padding from card border
    x0, y0 = inset, inset
    x1, y1 = CANVAS_SIZE - inset - 1, CANVAS_SIZE - inset - 1
    inner_radius = int(CARD_RADIUS * (ICON_SIZE / CANVAS_SIZE))
    draw.rounded_rectangle([x0, y0, x1, y1], radius=inner_radius, fill=(0, 0, 0, 255))

    target_px = int((y1 - y0) * 0.35)
    
    font = ImageFont.load_default(size=target_px)

    # Render text on a separate transparent layer to avoid any glyph advance issues
    inner_w = x1 - x0 + 1
    inner_h = y1 - y0 + 1
    text_img = Image.new("RGBA", (inner_w, inner_h), (0, 0, 0, 0))
    text_draw = ImageDraw.Draw(text_img)

    # Center text using anchor if supported; fallback to manual centering
    cx_local = inner_w // 2
    cy_local = inner_h // 2
    
    #draw text
    bbox = text_draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = int(cx_local - tw / 2)
    ty = int(cy_local - th / 2 - 48)
    text_draw.text((tx, ty), text, fill=(255, 255, 255, 255), font=font)

    # Composite the text into the black square area
    card.alpha_composite(text_img, dest=(x0, y0))

    return card

# ---------------------------- Generators ---------------------------- #

def generate_config(out_dir: str, app_name: str, app_url: str, icon_path: str):
    # Must match the basename of the generated .desktop file (without extension) for WM_CLASS / StartupWMClass / CHROME_DESKTOP.
    desktop_slug = f"WADspaces-{slugify(app_name)}"
    cfg = {
        "app_name": app_name,
        "app_url": app_url,
        "icon_path": icon_path,
        "wm_class": desktop_slug,
        "desktop_file": f"{desktop_slug}.desktop",
    }
    with open(os.path.join(out_dir, "config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)

def generate_url_redirect_launch_sh(out_dir: str, project_dir: str):
    # Launch the Electron app; URL from first argument (e.g. xdg-open %u)
    script = f"""#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="{project_dir}"
URL="${{1:-}}"

cd "$PROJECT_DIR"
if [ -n "$URL" ]; then
    exec npx electron . --url "$URL"
else
    exec npx electron .
fi"""
    write_executable(os.path.join(out_dir, "launch.sh"), script)
    
def generate_launch_sh(out_dir: str, project_dir: str, config_path: str):
    # Launch the Electron app with generated config (app_name, app_url, icon_path in config.json)
    script = f"""#!/usr/bin/env bash
set -euo pipefail
# Directory containing this script (and config.json); use absolute path so it works when run from .desktop or any cwd
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_PATH="$SCRIPT_DIR/config.json"
PROJECT_DIR="{os.path.abspath(project_dir)}"

cd "$PROJECT_DIR"
exec npx electron . --config "$CONFIG_PATH"
"""
    write_executable(os.path.join(out_dir, "launch.sh"), script)

def generate_desktop_file(app_name: str, exec_path: str, icon_path: str,
                          desktop_out_dir: str | None = None, apps_dir: str | None = None,
                          wm_class: str | None = None, url_redirect: bool | None=False):
    slug = "WADspaces-"+slugify(app_name)
    desktop_content = f"""[Desktop Entry]
Type=Application
Version=1.0
Name={app_name}
Comment=WADspaces: {app_name}
Icon={icon_path}
Terminal=false
Categories=Network;WebBrowser;
StartupNotify=true
"""
    if wm_class:
        desktop_content += f"StartupWMClass={wm_class}\n"

    if url_redirect:
        desktop_content += f"Exec=\"{exec_path}\" %u\n"
        desktop_content += f"MimeType=x-scheme-handler/http;x-scheme-handler/https;\n"
    else:
        desktop_content += f"Exec=\"{exec_path}\"\n"

    desktop_path = "None"

    if desktop_out_dir:
        desktop_path = os.path.join(desktop_out_dir, f"{slug}.desktop")
        write_executable(desktop_path, desktop_content)

    # Optionally also install to user applications
    if apps_dir:
        ensure_dir(apps_dir)
        write_executable(os.path.join(apps_dir, f"{slug}.desktop"), desktop_content)

    return desktop_path


# ---------------------------- Runner ---------------------------- #

def main():
    ap = argparse.ArgumentParser(description="Packager: generate mini-apps from resources.json")
    ap.add_argument("--input", "-i", default=DEFAULT_INPUT, help="Path to resources.json")
    ap.add_argument("--output", "-o", default=DEFAULT_OUTDIR, help="Output base directory (generated)")
    ap.add_argument("--project-dir", default=DEFAULT_PROJECT_DIR, help="MiniBrowser project directory (contains main.py)")
    ap.add_argument("--desktop-dir", default=DEFAULT_DESKTOP_DIR, help="Desktop directory to place .desktop files")
    ap.add_argument("--apps-dir", default=DEFAULT_APPS_DIR, help="Optional: also install .desktop into this dir")
    ap.add_argument("--no-apps-install", action="store_true", help="Do not copy .desktop into ~/.local/share/applications")
    ap.add_argument("--refetch", action="store_true", help="Force re-fetch of favicon even if cached")  # <— NEW
    args = ap.parse_args()

    # Validate paths
    ensure_dir(args.output)
    ensure_dir(args.desktop_dir)

    with open(args.input, "r", encoding="utf-8") as f:
        resources = json.load(f)

    if not isinstance(resources, list):
        print("resources.json must be a list of objects with app_name/app_url", file=sys.stderr)
        sys.exit(1)

    for entry in resources:
        app_name = entry.get("app_name") or "App"
        app_url = entry.get("app_url")
        if not app_url:
            print(f"Skipping {app_name}: missing app_url", file=sys.stderr)
            continue

        slug = slugify(app_name)
        app_dir = os.path.join(args.output, slug)
        ensure_dir(app_dir)

        print(f"▶ Packaging: {app_name} ({app_url})")

        original_path = os.path.join(app_dir, f"{slug}-original.png")
        icon_path = os.path.join(app_dir, f"{slug}.png")

        # 1) Load cached original or fetch anew
        try:
            if (not args.refetch) and os.path.exists(original_path):
                with open(original_path, "rb") as f:
                    raw_png_bytes = f.read()
            else:
                fetched_png_bytes, _ = fetch_best_favicon(app_url)
                raw_png_bytes = fetched_png_bytes
                with open(original_path, "wb") as f:
                    f.write(raw_png_bytes)
        except Exception as e:
            print(f"  ! Favicon fetch failed: {e}\n    Using fallback text icon.")
            raw_png_bytes = None

        # Determine localhost/port text fallback
        parsed = urlparse(app_url)
        hostname = parsed.hostname or "HTTP"
        is_localhost = hostname in {"localhost", "127.0.0.1", "::1"}
        # 2) Style to final icon
        try:
            if is_localhost:
                final_img = process_text_icon_on_card(":8080")
            elif raw_png_bytes:
                final_img = process_icon_to_card(raw_png_bytes)
            else:
                final_img = process_text_icon_on_card(hostname)
            final_img.save(icon_path, "PNG")
            print(f"  ✓ Wrote: {icon_path}")
        except Exception as e:
            print(f"  ! Icon processing failed: {e}\n    Writing cached original as final.")
            if raw_png_bytes:
                Image.open(BytesIO(raw_png_bytes)).save(icon_path, "PNG")
            else:
                # absolute fallback
                Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (255, 255, 255, 255)).save(icon_path, "PNG")

        # 3) config.json
        generate_config(
            out_dir=app_dir,
            app_name=app_name,
            app_url=app_url,
            icon_path=os.path.abspath(icon_path),
        )
        config_path = os.path.abspath(os.path.join(app_dir, "config.json"))
        print(f"  ✓ Wrote: {config_path}")

        # 4) launch.sh
        generate_launch_sh(app_dir, os.path.abspath(args.project_dir), config_path)
        launch_sh = os.path.abspath(os.path.join(app_dir, "launch.sh"))
        print(f"  ✓ Wrote: {launch_sh}")

        # 5) .desktop files
        desktop_file = generate_desktop_file(
            app_name=app_name,
            exec_path=launch_sh,
            icon_path=os.path.abspath(icon_path),
            desktop_out_dir=args.desktop_dir,
            apps_dir=None if args.no_apps_install else args.apps_dir,
            wm_class=f"WADspaces-{slugify(app_name)}",
            url_redirect=False,
        )
        print(f"  ✓ Desktop: {desktop_file}")

    print(f"▶ Packaging: URL Redirect")

    # Create app directory for URL redirect
    url_redirect_slug = "url-redirect"
    url_redirect_dir = os.path.join(args.output, url_redirect_slug)
    ensure_dir(url_redirect_dir)

    # Generate icon
    icon_path = os.path.join(url_redirect_dir, f"{url_redirect_slug}.png")
    final_img = process_text_icon_on_card("URL")
    final_img.save(icon_path, "PNG")
    print(f"  ✓ Wrote: {icon_path}")

    # Generate launch script
    generate_url_redirect_launch_sh(url_redirect_dir, os.path.abspath(args.project_dir))
    launch_sh = os.path.abspath(os.path.join(url_redirect_dir, "launch.sh"))
    print(f"  ✓ Wrote: {launch_sh}")

    # Generate desktop file
    desktop_file = generate_desktop_file(
            app_name=url_redirect_slug,
            exec_path=launch_sh,
            icon_path=os.path.abspath(icon_path),
            desktop_out_dir=None,
            apps_dir=None if args.no_apps_install else args.apps_dir,
            wm_class=None,
            url_redirect=True,
        )
    print(f"  ✓ Desktop: {desktop_file}")
    print("\nAll done ✅")

if __name__ == "__main__":
    main()
