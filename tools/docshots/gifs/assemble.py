#!/usr/bin/env python
"""Turn a folder of timestamped frames (written by record.mjs) into one GIF with Pillow.

    python assemble.py --frames DIR --out clip.gif [--crop x,y,w,h] [--width 860] [--fps 10]
                       [--colors 128] [--hold 1500] [--start MS] [--end MS] [--skip a-b,c-d]
                       [--preview DIR] [--preview-count 6]

DIR holds f00000.png ... and frames.json:
    {"end": ms, "frames": [{"t": ms, "file": "f00000.png"}, ...], "events": [{"t": ms, "label": "Ctrl + L"}, ...]}

How the picture is made
  * The clip is sampled at a fixed rate (default 10 fps): at every tick the newest frame at or before that time is
    used, so timing comes from the recorded timestamps (a fade keeps its real length) and a still page costs
    nothing. Identical neighbours are merged into one frame with a longer delay; every delay is a multiple of
    10 ms and at least 100 ms.
  * Each frame is cropped, then scaled to the target width (a crop already that wide is left untouched).
  * ONE global palette (default 128 colours) is built from the colours of the whole clip: the most frequent colours
    (background, text, the UI greys) are kept exactly, the remaining slots go one by one to the colour the palette
    represents worst (weighted by the square root of its pixel count), so a thin accent bar keeps its hue and the
    amber glow and the anti-aliasing steps are covered evenly. Pillow's own P conversion snaps colours to a coarse grid
    (a grey text colour can turn brownish), so every frame is mapped to the palette here, colour by colour, with a
    nearest-colour lookup. No dithering: text stays crisp.
  * The last frame is held for --hold ms; the GIF loops forever.
  * --preview writes ~N evenly spaced frames of the finished GIF as PNG, plus one frame shortly after every key-cap
    event recorded in frames.json, for checking the result by eye.
Prints one line of JSON with the result (bytes, frames, seconds, size).
"""
import argparse
import hashlib
import json
import math
import os
import sys

from PIL import Image


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument('--frames', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--crop', default='')
    ap.add_argument('--width', type=int, default=860)
    ap.add_argument('--fps', type=float, default=10.0)
    ap.add_argument('--colors', type=int, default=128)
    ap.add_argument('--hold', type=int, default=1500)
    ap.add_argument('--start', type=int, default=0)
    ap.add_argument('--end', type=int, default=-1)
    ap.add_argument('--preview', default='')
    ap.add_argument('--preview-count', type=int, default=6)
    ap.add_argument('--skip', default='', help='ms ranges to cut out of the clip, e.g. 1200-1500,4000-4100')
    return ap.parse_args()


def load_meta(folder):
    with open(os.path.join(folder, 'frames.json'), 'r', encoding='utf-8') as fh:
        meta = json.load(fh)
    frames = sorted(meta['frames'], key=lambda f: f['t'])
    end = max(int(meta.get('end', 0)), frames[-1]['t'] if frames else 0)
    return frames, end, meta.get('events', [])


def parse_skips(text):
    out = []
    for part in [p for p in text.split(',') if p.strip()]:
        a, b = part.split('-')
        out.append((int(a), int(b)))
    return out


def pick_ticks(frames, start, end, step, skips):
    """(tick time, frame index) at every tick: the newest frame at or before it."""
    picks = []
    j = 0
    t = float(start)
    while t < end - 1e-6:
        if not any(a <= t < b for a, b in skips):
            while j + 1 < len(frames) and frames[j + 1]['t'] <= t:
                j += 1
            picks.append((t, j))
        t += step
    return picks


def prepare(frame_path, crop, width):
    im = Image.open(frame_path).convert('RGB')
    if crop:
        x, y, w, h = crop
        im = im.crop((x, y, x + w, y + h))
    if width and im.width != width:
        height = max(1, round(im.height * width / im.width))
        im = im.resize((width, height), Image.LANCZOS)
    return im


def key_of(rgb):
    """The packed value the RGBA byte view of an image gives for this colour (little endian, alpha 255)."""
    return rgb[0] | (rgb[1] << 8) | (rgb[2] << 16) | (255 << 24)


def color_dist(a, b):
    return 2 * (a[0] - b[0]) ** 2 + 4 * (a[1] - b[1]) ** 2 + 3 * (a[2] - b[2]) ** 2


def build_palette(images, colors):
    """The palette (list of RGB tuples) for the whole clip and the number of distinct source colours.

    The most frequent colours (background, text, the UI greys) go in exactly. The remaining slots are filled greedily:
    each time the colour that is worst represented by the palette so far, weighted by the square root of its pixel
    count, is added. A rare but meaningful colour (a 2 px accent bar) therefore gets its own entry instead of being
    averaged into a neighbour, and smooth ramps (the amber glow, anti-aliasing steps) end up evenly covered.
    """
    counts = {}
    for im in images:
        for n, rgb in im.getcolors(maxcolors=im.width * im.height) or []:
            counts[rgb] = counts.get(rgb, 0) + n
    items = sorted(counts.items(), key=lambda kv: -kv[1])
    n_exact = min(len(items), max(8, colors // 3))
    palette = [rgb for rgb, _ in items[:n_exact]]
    cols = [rgb for rgb, _ in items]
    weight = [math.sqrt(n) for _, n in items]
    mind = [min(color_dist(c, p) for p in palette) for c in cols]
    while len(palette) < colors:
        best, best_score = -1, 0.0
        for i, d in enumerate(mind):
            score = d * weight[i]
            if score > best_score:
                best, best_score = i, score
        if best < 0:
            break                       # every colour is in the palette already
        new = cols[best]
        palette.append(new)
        for i, c in enumerate(cols):
            d = color_dist(c, new)
            if d < mind[i]:
                mind[i] = d
    return palette, len(counts)


class Lookup(dict):
    """Packed RGBA value -> palette index (nearest palette colour), filled on demand."""

    def __init__(self, palette):
        super().__init__()
        self.palette = palette
        for i, rgb in enumerate(palette):
            self.setdefault(key_of(rgb), i)

    def __missing__(self, key):
        r, g, b = key & 255, (key >> 8) & 255, (key >> 16) & 255
        best, best_d = 0, 1 << 60
        for i, (pr, pg, pb) in enumerate(self.palette):
            d = color_dist((r, g, b), (pr, pg, pb))
            if d < best_d:
                best, best_d = i, d
        self[key] = best
        return best


def to_palette(im, lut, flat_palette):
    view = memoryview(im.convert('RGBA').tobytes()).cast('I')
    data = bytes(map(lut.__getitem__, view))
    out = Image.frombytes('P', im.size, data)
    out.putpalette(flat_palette)
    return out


def main():
    a = parse_args()
    frames, meta_end, events = load_meta(a.frames)
    if not frames:
        print(json.dumps({'ok': False, 'error': 'no frames'}))
        return 1
    end = meta_end if a.end < 0 else a.end
    crop = tuple(int(v) for v in a.crop.split(',')) if a.crop else None
    step = 1000.0 / a.fps
    picks = pick_ticks(frames, a.start, end, step, parse_skips(a.skip))

    # Group identical neighbouring picks; each group keeps the time of its first tick.
    cache = {}
    ordered = []          # [image, ticks, start_ms]
    last_hash = None
    for tick, idx in picks:
        if idx not in cache:
            cache[idx] = prepare(os.path.join(a.frames, frames[idx]['file']), crop, a.width)
        im = cache[idx]
        h = hashlib.md5(im.tobytes()).hexdigest()
        if ordered and h == last_hash:
            ordered[-1][1] += 1
        else:
            ordered.append([im, 1, tick])
            last_hash = h
    if not ordered:
        print(json.dumps({'ok': False, 'error': 'nothing left after skips'}))
        return 1

    unique = []
    seen = set()
    for im, _, _ in ordered:
        h = hashlib.md5(im.tobytes()).hexdigest()
        if h not in seen:
            seen.add(h)
            unique.append(im)
    palette, distinct = build_palette(unique, a.colors)
    flat = []
    for r, g, b in palette:
        flat.extend([r, g, b])
    flat.extend([0] * (768 - len(flat)))
    lut = Lookup(palette)
    quantized = [to_palette(im, lut, flat) for im, _, _ in ordered]

    durations = [max(100, int(round(ticks * step / 10.0)) * 10) for _, ticks, _ in ordered]
    durations[-1] += int(round(a.hold / 10.0)) * 10

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    quantized[0].save(
        a.out, save_all=True, append_images=quantized[1:], duration=durations, loop=0,
        optimize=True, disposal=1,
    )
    size = os.path.getsize(a.out)

    if a.preview:
        os.makedirs(a.preview, exist_ok=True)
        gif = Image.open(a.out)
        n = gif.n_frames
        total = sum(durations)
        starts = []
        acc = 0
        for d in durations:
            starts.append(acc)
            acc += d
        base = os.path.splitext(os.path.basename(a.out))[0]

        def frame_at(ms):
            fi = 0
            for i, s in enumerate(starts):
                if s <= ms:
                    fi = i
            gif.seek(min(fi, n - 1))
            return gif.convert('RGB')

        for k in range(a.preview_count):
            tm = total - 50 if k == a.preview_count - 1 else total * (k + 0.5) / a.preview_count
            frame_at(tm).save(os.path.join(a.preview, '%s-%02d.png' % (base, k + 1)))
        for k, ev in enumerate(events):
            t0 = max(0, ev['t'] - a.start)
            for tag, tm in (('pre', max(0, t0 - 150)), ('post', t0 + 350)):
                if tm < total:
                    frame_at(tm).save(os.path.join(a.preview, '%s-key%02d%s.png' % (base, k + 1, tag)))

    out_w, out_h = quantized[0].size
    print(json.dumps({
        'ok': True, 'bytes': size, 'frames': len(quantized), 'seconds': round(sum(durations) / 1000.0, 2),
        'width': out_w, 'height': out_h, 'colors': len(palette), 'sourceColors': distinct,
        'minDelay': min(durations), 'sourceFrames': len(frames),
    }))
    return 0


if __name__ == '__main__':
    sys.exit(main())
