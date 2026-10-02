#!/usr/bin/env python3
"""Checks manual.html and manual_ja.html after an edit (python tools/check_manual.py).

  - every id is unique, every href="#..." resolves, every tag that must close is closed (div, section, figure, ol, ul, table, details)
  - every <figure class="fig"> has an image that exists on disk, and its legend (ol.fig-legend) has as many items as the shot has markers
    in tools/docshots/shots.json (the legend is the markers' text, so the numbers must agree)
  - the two manuals agree: the same ids, the same number of figures, the same images (the tables are only compared as a note)
  - no emoji, no tab characters used for layout
  - coverage: every JSON-RPC method of app_rpc.go and every command word of pkg/cli/registry.go is in both manuals (a new method or
    command that nobody wrote up fails here), and `tab pdf`, `scrap index` and `--semantic` are shown

Exit 1 with the findings printed, 0 when clean. Read-only: it changes nothing.
"""
import json
import os
import re
import sys
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANUALS = ['manual.html', 'manual_ja.html']
MUST_CLOSE = {'div', 'section', 'figure', 'ol', 'ul', 'table', 'details', 'tbody', 'thead', 'tr', 'figcaption', 'a', 'p', 'li', 'td', 'th', 'summary', 'pre', 'code', 'strong', 'em', 'span'}
VOID = {'img', 'br', 'hr', 'meta', 'link', 'input', 'source', 'wbr', 'col', 'path', 'polygon', 'circle', 'rect', 'line', 'polyline', 'ellipse'}
EMOJI = re.compile('[\U0001F300-\U0001FAFF☀-⛿✀-➿⭐⭕]')  # pictographs (the plain cross is allowed: it is in the app)


class Scan(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids = []
        self.hrefs = []
        self.stack = []
        self.problems = []
        self.figures = []  # {'img': src, 'items': n}
        self._fig = None
        self._legend_depth = None
        self.tables = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if 'id' in a:
            self.ids.append(a['id'])
        if tag == 'a' and a.get('href', '').startswith('#') and len(a['href']) > 1:
            self.hrefs.append(a['href'][1:])
        if tag == 'table':
            self.tables += 1
        if tag not in VOID:
            self.stack.append((tag, self.getpos()[0]))
        classes = (a.get('class') or '').split()
        if tag == 'figure' and 'fig' in classes:
            self._fig = {'img': None, 'items': 0, 'line': self.getpos()[0]}
        if tag == 'img' and self._fig is not None and self._fig['img'] is None:
            self._fig['img'] = a.get('src')
        if tag == 'ol' and 'fig-legend' in classes and self._fig is not None:
            self._legend_depth = len(self.stack)
        if tag == 'li' and self._legend_depth is not None and len(self.stack) == self._legend_depth + 1:
            self._fig['items'] += 1

    def handle_startendtag(self, tag, attrs):
        a = dict(attrs)
        if 'id' in a:
            self.ids.append(a['id'])
        if tag == 'img' and self._fig is not None and self._fig['img'] is None:
            self._fig['img'] = a.get('src')

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack:
            self.problems.append(f'line {self.getpos()[0]}: </{tag}> with nothing open')
            return
        top, line = self.stack[-1]
        if top == tag:
            self.stack.pop()
        else:
            # an unclosed optional tag (p, li, td, th, tr) is closed by its parent's end: tolerate those, report the rest
            if top in ('p', 'li', 'td', 'th', 'tr', 'tbody', 'thead'):
                while self.stack and self.stack[-1][0] != tag and self.stack[-1][0] in ('p', 'li', 'td', 'th', 'tr', 'tbody', 'thead'):
                    self.stack.pop()
                if self.stack and self.stack[-1][0] == tag:
                    self.stack.pop()
                    return
            self.problems.append(f'line {self.getpos()[0]}: </{tag}> but <{top}> from line {line} is still open')
            for i in range(len(self.stack) - 1, -1, -1):
                if self.stack[i][0] == tag:
                    del self.stack[i:]
                    break
        if tag == 'ol' and self._legend_depth is not None and len(self.stack) < self._legend_depth:
            self._legend_depth = None
        if tag == 'figure' and self._fig is not None:
            self.figures.append(self._fig)
            self._fig = None
            self._legend_depth = None


def markers_by_image():
    path = os.path.join(ROOT, 'tools', 'docshots', 'shots.json')
    data = json.load(open(path, encoding='utf-8'))
    out = {}
    for shot in data.get('shots', []):
        out[shot['name']] = len(shot.get('markers', []))
    return out


def check(name):
    path = os.path.join(ROOT, name)
    text = open(path, encoding='utf-8').read()
    s = Scan()
    s.feed(text)
    problems = list(s.problems)
    for tag, line in s.stack:
        if tag in MUST_CLOSE:
            problems.append(f'<{tag}> from line {line} is never closed')
    seen = set()
    for i in s.ids:
        if i in seen:
            problems.append(f'duplicate id "{i}"')
        seen.add(i)
    for h in s.hrefs:
        if h not in seen:
            problems.append(f'href="#{h}" has no target')
    marks = markers_by_image()
    for f in s.figures:
        src = f['img'] or ''
        if not src:
            problems.append(f'figure at line {f["line"]} has no image')
            continue
        if not os.path.exists(os.path.join(ROOT, src.replace('./', '', 1))):
            problems.append(f'figure at line {f["line"]}: {src} does not exist')
        base = os.path.splitext(os.path.basename(src))[0]
        if base in marks and marks[base] != f['items']:
            problems.append(f'figure {base} (line {f["line"]}): the legend has {f["items"]} items, the shot has {marks[base]} markers')
    for m in EMOJI.finditer(text):
        if m.group(0) in ('✕', '⚠'):  # the cross, and the warning sign that the app itself writes in an agent's error line
            continue
        line = text.count('\n', 0, m.start()) + 1
        problems.append(f'line {line}: emoji {m.group(0)!r}')
    if '\t' in text:
        problems.append(f'tab characters in the file (first at line {text.count(chr(10), 0, text.index(chr(9))) + 1})')
    return problems, s


def rpc_methods():
    # every JSON-RPC method the app answers (the cases of DispatchRPCOperation)
    src = open(os.path.join(ROOT, 'app_rpc.go'), encoding='utf-8').read()
    return sorted(set(re.findall(r'case "([a-z_]+\.[a-z_]+)":', src)))


def cli_words():
    # the command words of the CLI registry, and `tab` actions the manual must show
    src = open(os.path.join(ROOT, 'pkg', 'cli', 'registry.go'), encoding='utf-8').read()
    return sorted(set(re.findall(r'\{name: "([a-z]+)"', src)))


def main():
    results = {}
    failed = False
    for name in MANUALS:
        problems, scan = check(name)
        results[name] = scan
        print(f'== {name}: {len(scan.ids)} ids, {len(scan.figures)} figures, {scan.tables} tables')
        for p in problems:
            failed = True
            print('  PROBLEM:', p)
    en, ja = results[MANUALS[0]], results[MANUALS[1]]
    only_en = sorted(set(en.ids) - set(ja.ids))
    only_ja = sorted(set(ja.ids) - set(en.ids))
    if only_en or only_ja:
        failed = True
        print('== parity: ids only in manual.html:', only_en, '| only in manual_ja.html:', only_ja)
    if len(en.figures) != len(ja.figures):
        failed = True
        print(f'== parity: {len(en.figures)} figures in manual.html, {len(ja.figures)} in manual_ja.html')
    imgs_en = sorted(os.path.basename(f['img'] or '') for f in en.figures)
    imgs_ja = sorted(os.path.basename(f['img'] or '') for f in ja.figures)
    if imgs_en != imgs_ja:
        failed = True
        print('== parity: the figures show different images:', sorted(set(imgs_en) ^ set(imgs_ja)))
    if en.tables != ja.tables:  # a warning: the Screen Capture section has had a table in the Japanese manual only
        print(f'== note: {en.tables} tables in manual.html, {ja.tables} in manual_ja.html (compare them by section if this number changes)')
    # coverage: what the app can do must be in both manuals (the manual is where a person looks first)
    for name in MANUALS:
        text = open(os.path.join(ROOT, name), encoding='utf-8').read()
        missing = [m for m in rpc_methods() if f'<code>{m}</code>' not in text]
        if missing:
            failed = True
            print(f'== coverage: {name} does not document these JSON-RPC methods: {", ".join(missing)}')
        absent = [w for w in cli_words() if f'md-memo {w}' not in text]
        if absent:
            failed = True
            print(f'== coverage: {name} never shows the commands: {", ".join("md-memo " + w for w in absent)}')
        for needle in ('md-memo tab pdf', 'md-memo scrap index', '--semantic'):
            if needle not in text:
                failed = True
                print(f'== coverage: {name} never mentions "{needle}"')
    print('FAILED' if failed else 'clean')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
