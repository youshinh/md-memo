"""Manual figures of the two native Windows pieces of Quick Capture, which the CDP screenshots of
tools/docshots cannot show (they are not web pages):

  quick-capture-popup.png    the popup, drawn by its own code, floating over a manual screenshot
  screen-capture-pick.png    the picker: dimmed screen, hint bar, numbered frames, a frame being dragged

usage (from the repository root, on Windows):
  set DOCSHOTS_OUT=<some empty folder>
  go test -tags nativeprobe -run DocshotsNative -v .          (renders popup_*.png, overlay_*.png there)
  python tools/docshots/native/compose_native.py <DOCSHOTS_OUT> (writes img/manual/{en,ja}/*.png)

The renders come from the app's own paint code through PrintWindow, so nothing is read from the screen
and the result does not depend on what is on it. The backdrop is img/manual/<lang>/ui-map.png with its
numbered markers painted out; the markers on the figures are drawn with docshots' own draw_marker.
Re-run both steps when the popup or the picker changes look (quickcapture_windows.go, imgcap_windows.go).
"""
import importlib.util
import math
import os
import sys
from collections import Counter

from PIL import Image, ImageChops, ImageDraw, ImageFilter

here = os.path.dirname(os.path.abspath(__file__))
repo = os.path.abspath(os.path.join(here, '..', '..', '..'))
spec = importlib.util.spec_from_file_location('pp', os.path.join(repo, 'tools', 'docshots', 'postprocess.py'))
pp = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(pp)

ORANGE = pp.MARKER_ORANGE
ALPHA = 217 / 255.0            # quickCaptureAlpha
BORDER = (0x3e, 0x3e, 0x42)     # colBorder
RADIUS = 8                      # Windows 11 rounded corner
VEIL = 36 / 255.0               # capVeilAlpha
HINT = (560, 12, 1120, 40)      # where the picker paints its hint bar on the renderer's 1680 px main monitor
DESKTOP = (1120, 720)


def marker_centres(im):
    px = im.load()
    W, H = im.size
    out = []
    for y in range(H):
        for x in range(W):
            if px[x, y] == ORANGE:
                for c in out:
                    if abs(c[0] - x) < 20 and abs(c[1] - y) < 20:
                        c[2].append((x, y))
                        c[0] = sum(p[0] for p in c[2]) / len(c[2])
                        c[1] = sum(p[1] for p in c[2]) / len(c[2])
                        break
                else:
                    out.append([x, y, [(x, y)]])
    return [(c[0], c[1]) for c in out]


def backdrop(lang):
    """ui-map.png with its numbered markers painted over, row by row (a marker can straddle two areas)."""
    im = Image.open(os.path.join(repo, 'img', 'manual', lang, 'ui-map.png')).convert('RGB')
    W, H = im.size
    src = im.copy().load()
    d = ImageDraw.Draw(im)
    for cx, cy in marker_centres(im):
        for y in range(int(cy) - 17, int(cy) + 18):
            if not 0 <= y < H:
                continue
            half = int(math.sqrt(max(0, 17 * 17 - (y - cy) ** 2)))
            side = Counter(src[int(round(cx + dx)), y] for dx in (-22, -21, -20, 20, 21, 22) if 0 <= int(round(cx + dx)) < W)
            d.line((cx - half, y, cx + half, y), fill=side.most_common(1)[0][0])
    return im


def popup(work, lang):
    bg = backdrop(lang).crop((0, 300, 820, 470)).filter(ImageFilter.GaussianBlur(2.4))
    W, H = bg.size
    pop = Image.open(os.path.join(work, 'popup_%s.png' % lang)).convert('RGB')
    w, h = pop.size
    mask = Image.new('L', (w * 4, h * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w * 4 - 1, h * 4 - 1), radius=RADIUS * 4, fill=255)
    mask = mask.resize((w, h), Image.LANCZOS)
    ImageDraw.Draw(pop).rounded_rectangle((0, 0, w - 1, h - 1), radius=RADIUS, outline=BORDER, width=1)
    px, py = 48, 56
    shadow = Image.new('L', (W, H), 0)
    shadow.paste(mask.point(lambda v: int(v * 0.55)), (px, py + 4))
    shadow = shadow.filter(ImageFilter.GaussianBlur(7))
    canvas = Image.composite(Image.new('RGB', (W, H), (0, 0, 0)), bg, shadow)
    behind = canvas.crop((px, py, px + w, py + h))
    canvas.paste(Image.blend(behind, pop, ALPHA), (px, py), mask)   # the popup is see-through
    for n, cx in enumerate([236, 512, 596, 680], 1):                # field, Send, AI Send, Capture
        pp.draw_marker(canvas, n, px + cx, py + h + 22, 26)
    return canvas


def picker(work, lang):
    W, H = DESKTOP
    canvas = Image.blend(backdrop(lang), Image.new('RGB', (W, H), (0, 0, 0)), VEIL)   # the input layer's veil
    render = Image.open(os.path.join(work, 'overlay_%s.png' % lang)).convert('RGB')
    hint = render.crop(HINT)
    render.paste((0, 0, 0), HINT)                                   # black = outside the frame window's region
    r, g, b = render.split()
    mask = ImageChops.lighter(ImageChops.lighter(r, g), b).point(lambda v: 255 if v > 0 else 0)
    canvas.paste(render, (0, 0), mask)
    canvas.paste(hint, ((W - hint.width) // 2, HINT[1]))            # the hint bar, centred on this desktop
    for n, (x, y) in enumerate([(W // 2, 64), (382, 240), (452, 598), (860, 330)], 1):
        pp.draw_marker(canvas, n, x, y, 26)
    return canvas


def main():
    work = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('DOCSHOTS_OUT')
    if not work:
        raise SystemExit(__doc__)
    for lang in ('en', 'ja'):
        for name, fn in (('quick-capture-popup', popup), ('screen-capture-pick', picker)):
            out = os.path.join(repo, 'img', 'manual', lang, name + '.png')
            fn(work, lang).save(out, optimize=True)
            print('wrote', out)


if __name__ == '__main__':
    main()
