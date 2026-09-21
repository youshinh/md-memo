"""Verify, crop, annotate and shrink one documentation screenshot.

usage: python postprocess.py spec.json

The spec is written by run.mjs. It names the raw capture (from UWSCR, or the CDP screenshot when the
CDP fallback is in use), a reference screenshot taken through CDP at the same moment, the viewport
size, an optional crop / scale, the call-out markers and the output path.

Checks (exit code 3 when one fails, so the caller can retry or fall back):
  * the picture is not blank (black / uniform),
  * it matches the CDP reference of the demo page: a capture of another window would not.
"""
import json
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat

MARKER_ORANGE = (232, 116, 59)   # #e8743b
MARKER_RING = (255, 255, 255)
SUPERSAMPLE = 4


def load_rgb(path):
    return Image.open(path).convert("RGB")


def diff_stats(a, b):
    d = ImageChops.difference(a, b)
    mean = sum(ImageStat.Stat(d).mean) / 3.0
    mask = d.convert("L").point(lambda v: 255 if v > 40 else 0)
    frac = ImageStat.Stat(mask).mean[0] / 255.0
    return mean, frac


def locate_viewport(raw, ref, vw, vh):
    """The window's client area also holds the browser caption bar: find the page viewport inside it."""
    ox0 = max(0, raw.width - vw)
    oy0 = max(0, raw.height - vh)
    best = None
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            ox, oy = ox0 + dx, oy0 + dy
            if ox < 0 or oy < 0 or ox + vw > raw.width or oy + vh > raw.height:
                continue
            crop = raw.crop((ox, oy, ox + vw, oy + vh))
            mean, frac = diff_stats(crop, ref)
            score = mean + frac * 100
            if best is None or score < best[0]:
                best = (score, ox, oy, mean, frac, crop)
    if best is None:
        raise ValueError("capture is smaller than the viewport (%dx%d < %dx%d)" % (raw.width, raw.height, vw, vh))
    return best


def is_blank(img):
    g = img.convert("L")
    st = ImageStat.Stat(g)
    if st.mean[0] < 3 or st.stddev[0] < 4.0:
        return True
    return len(g.getcolors(maxcolors=256 * 256) or []) < 8


def font_for(px):
    for name in ("segoeuib.ttf", "arialbd.ttf", "seguisb.ttf", "verdanab.ttf"):
        for base in (r"C:\Windows\Fonts", "/usr/share/fonts/truetype/dejavu", "/Library/Fonts"):
            p = os.path.join(base, name)
            if os.path.exists(p):
                return ImageFont.truetype(p, px)
    return ImageFont.load_default()


def draw_marker(img, n, cx, cy, diameter):
    s = SUPERSAMPLE
    d = int(diameter)
    pad = 2
    size = (d + pad * 2) * s
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    g = ImageDraw.Draw(layer)
    c = size / 2.0
    r_out = d * s / 2.0
    ring = 2 * s
    g.ellipse((c - r_out, c - r_out, c + r_out, c + r_out), fill=MARKER_RING + (255,))
    r_in = r_out - ring
    g.ellipse((c - r_in, c - r_in, c + r_in, c + r_in), fill=MARKER_ORANGE + (255,))
    fs = int(d * 0.60 * s)
    font = font_for(fs)
    g.text((c, c), str(n), font=font, fill=(255, 255, 255, 255), anchor="mm")
    layer = layer.resize((d + pad * 2, d + pad * 2), Image.LANCZOS)
    x = int(round(cx - layer.width / 2.0))
    y = int(round(cy - layer.height / 2.0))
    img.paste(layer, (x, y), layer)


def clamp_center(v, size, d):
    half = d / 2.0 + 2
    return min(max(v, half), size - half)


def main():
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    vw, vh = spec["viewport"]
    ref = load_rgb(spec["ref"])
    result = {"method": spec["method"]}

    if ref.size != (vw, vh):
        vw, vh = ref.size
        result["viewport_note"] = "reference size %dx%d differs from the requested viewport" % (vw, vh)

    if spec["method"] == "uwscr":
        raw = load_rgb(spec["raw"])
        if is_blank(raw):
            result.update(ok=False, error="UWSCR capture is blank")
            print(json.dumps(result))
            return 3
        score, ox, oy, mean, frac, base = locate_viewport(raw, ref, vw, vh)
        result.update(offset=[ox, oy], raw_size=list(raw.size))
    else:
        base = ref
        mean, frac = 0.0, 0.0
        result.update(offset=[0, 0])

    result.update(diff_mean=round(mean, 4), diff_frac=round(frac, 5))
    if is_blank(base):
        result.update(ok=False, error="picture is blank")
        print(json.dumps(result))
        return 3
    if mean > spec.get("diff_mean_max", 3.0) or frac > spec.get("diff_frac_max", 0.03):
        result.update(ok=False, error="capture does not match the CDP reference of the demo page (wrong window or stale frame)")
        print(json.dumps(result))
        return 3

    img = base
    crop = spec.get("crop")
    ox, oy = 0, 0
    if crop:
        x, y, w, h = [int(round(v)) for v in crop]
        x = max(0, min(x, vw - 1))
        y = max(0, min(y, vh - 1))
        w = min(w, vw - x)
        h = min(h, vh - y)
        img = img.crop((x, y, x + w, y + h))
        ox, oy = x, y
    scale = float(spec.get("scale", 1))
    if scale != 1:
        img = img.resize((int(round(img.width * scale)), int(round(img.height * scale))), Image.LANCZOS)

    d = int(spec.get("marker_diameter", 26))
    for m in spec.get("markers", []):
        cx = (m["x"] - ox) * scale
        cy = (m["y"] - oy) * scale
        cx = clamp_center(cx, img.width, d)
        cy = clamp_center(cy, img.height, d)
        draw_marker(img, m["n"], cx, cy, d)

    out = spec["out"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save(out, format="PNG", optimize=True)
    size = os.path.getsize(out)
    limit = spec.get("max_bytes", 150 * 1024)
    if size > limit:
        q = img.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        pal = q.getpalette()
        # keep the marker colours exact
        for target in (MARKER_ORANGE, MARKER_RING):
            best, bi = None, 0
            for i in range(len(pal) // 3):
                r, g, b = pal[i * 3:i * 3 + 3]
                dist = (r - target[0]) ** 2 + (g - target[1]) ** 2 + (b - target[2]) ** 2
                if best is None or dist < best:
                    best, bi = dist, i
            if best is not None and best < 900:
                pal[bi * 3:bi * 3 + 3] = list(target)
        q.putpalette(pal)
        q.save(out, format="PNG", optimize=True)
        size = os.path.getsize(out)
        result["quantized"] = True

    result.update(ok=True, size=list(img.size), bytes=size, out=out)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # report, do not traceback: run.mjs prints this
        print(json.dumps({"ok": False, "error": str(exc)}))
        sys.exit(1)
