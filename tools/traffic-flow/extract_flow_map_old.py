"""
Extract the City of Winnipeg Traffic Flow Maps for 2008-2018 (the older,
non-QGIS PDFs) into the same GeoJSON as extract_flow_map.py.

    python extract_flow_map_old.py <flow-map.pdf> <out.geojson> --year 2015 --reference ../../web/public/traffic-flow-2019.geojson [--review review.html]

HOW THESE DIFFER FROM 2019 ON, AND HOW THIS READS THEM
  * No georeferencing, and the map's scale and position on the page change
    from year to year. Each year is fitted onto the 2019 extraction (the
    reference): its volume lines are matched to the 2019 lines by FFT
    correlation over scale and shift, then refined by ICP (similarity:
    scale, rotation, shift). Major streets barely move between years, so
    this lands the old map on the ground; the fit residual is printed.
  * The volumes are real text (red), so they are read directly, with their
    writing direction for the label's angle.
  * Volume lines: green strokes whose width is the volume (2008, 2009,
    2015, 2018). 2012 draws them as filled green triangles instead, with a
    thin black centreline inside; there the centrelines are the lines and
    their width is measured from the triangles around them.
  * The downtown inset (white background, bottom right) is handled as in
    extract_flow_map.py: drawing order separates it from the main map, and
    it is fitted onto the main map by its streets.
  * Label -> line assignment, section chaining and the output format are
    extract_flow_map.py's own.
"""

import argparse
import collections
import html
import json
import math
import re
import sys

import fitz
import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
from scipy import ndimage, signal
from scipy.spatial import cKDTree

import extract_flow_map as E
from inset_fit import fit_inset, densify

RED = (1.0, 0.0, 0.0)
UTM = 26914


def rgb2(c):
    return tuple(round(v, 2) for v in c) if c else None


def greenish(c):
    return c is not None and c[1] >= 0.45 and c[0] <= 0.3 and c[2] <= 0.3


# ---------------------------------------------------------------- lines
def polyline(items):
    pts = []
    for it in items:
        if it[0] == 'l':
            seg = [(it[1].x, it[1].y), (it[2].x, it[2].y)]
        elif it[0] == 'c':
            seg = [(it[1].x, it[1].y), (it[4].x, it[4].y)]
        else:
            continue
        for q in seg:
            if not pts or math.hypot(pts[-1][0] - q[0], pts[-1][1] - q[1]) > 1e-6:
                pts.append(q)
    return pts


def load_pieces_old(drawings):
    """Volume lines as pieces {pts, w, seq}. Green strokes when the year has
    them; otherwise (2012) black centrelines inside the green triangles."""
    strokes = [x for x in drawings if x['type'] == 's' and greenish(x.get('color')) and (x.get('width') or 0) >= 0.5]
    if len(strokes) > 500:
        best = {}
        for x in strokes:   # some years draw a piece twice; keep the widest
            pts = polyline(x['items'])
            if len(pts) < 2:
                continue
            k = (round(pts[0][0], 1), round(pts[0][1], 1), round(pts[-1][0], 1), round(pts[-1][1], 1))
            if k not in best or x['width'] > best[k]['w']:
                best[k] = {'pts': pts, 'w': round(x['width'], 1), 'seq': x['seqno']}
        return list(best.values()), 'green strokes'

    tris = [x for x in drawings if x['type'] == 'f' and greenish(x.get('fill'))]
    if len(tris) < 500:
        sys.exit('no volume lines found: neither green strokes nor green fills')
    tri_pts = []
    for x in tris:
        for it in x['items']:
            if it[0] == 'l':
                tri_pts += [(it[1].x, it[1].y), (it[2].x, it[2].y)]
    tree = cKDTree(np.array(tri_pts))
    pieces = []
    for x in drawings:
        if x['type'] != 's' or rgb2(x.get('color')) != (0.0, 0.0, 0.0) or (x.get('width') or 0) > 0.5:
            continue
        pts = polyline(x['items'])
        if len(pts) < 2:
            continue
        # width: twice the furthest triangle vertex from the centreline,
        # among vertices within 8 pt of the piece's middle
        m = E.mid(pts)
        a, b = pts[0], pts[-1]
        idx = tree.query_ball_point(m, 8.0)
        if not idx:
            continue                     # a black line not inside a volume line
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1e-9
        perp = [abs((tri_pts[i][0] - a[0]) * dy - (tri_pts[i][1] - a[1]) * dx) / L for i in idx]
        w = 2 * max(perp)
        if w < 0.3 or w > 25:
            continue
        pieces.append({'pts': pts, 'w': round(w * 2) / 2, 'seq': x['seqno']})   # 0.5 pt classes
    return pieces, 'black centrelines in green fills'


# --------------------------------------------------------------- labels
def split_span(chars):
    """A text span can hold two labels that happen to sit in line
    ("21,500" and "45,300" printed one after the other along a street).
    Split it wherever consecutive characters are further apart than one
    number's letter spacing, or at a space. Returns lists of chars."""
    if not chars:
        return []
    steps = [math.hypot(b[2][0] - a[2][0], b[2][1] - a[2][1]) for a, b in zip(chars, chars[1:])]
    typical = sorted(steps)[len(steps) // 2] if steps else 0
    groups, cur = [], [chars[0]]
    for c, step in zip(chars[1:], steps):
        if chr(c[0]).isspace() or (typical and step > 1.8 * typical):
            groups.append(cur)
            cur = [] if chr(c[0]).isspace() else [c]
        else:
            cur.append(c)
    groups.append(cur)
    return [[c for c in g if not chr(c[0]).isspace()] for g in groups if g]


def load_text_labels(page):
    labels = []
    for sp in page.get_texttrace():
        if tuple(round(v, 2) for v in sp['color']) != RED:
            continue
        for chars in split_span(sp['chars']):
            for part in split_number(chars):
                lab = text_label(part, sp)
                if lab:
                    labels.append(lab)
    return labels


MAX_VOLUME = 150000


def split_number(chars):
    """Two labels can also touch with normal spacing ("13,50015,000").
    With commas, a number is d{1,3}(,ddd)*, which splits it unambiguously;
    without (2009 prints "24700"), split where every part ends in 00 and is
    a plausible volume, preferring the fewest parts. Anything else is left
    whole (and flagged by text_label)."""
    text = ''.join(chr(c[0]) for c in chars)
    if not re.fullmatch(r'[\d,]+', text):
        return [chars]
    if ',' in text:
        out, pos = [], 0
        for m in re.finditer(r'\d{1,3}(?:,\d{3})+|\d+', text):
            if m.start() != pos:
                return [chars]
            out.append(chars[m.start():m.end()])
            pos = m.end()
        return out if pos == len(text) else [chars]
    if int(text) <= MAX_VOLUME:
        return [chars]
    best = None

    def ok(t):
        return t.endswith('00') and not t.startswith('0') and 100 <= int(t) <= MAX_VOLUME

    def search(i, acc):
        nonlocal best
        if i == len(text):
            if best is None or len(acc) < len(best):
                best = list(acc)
            return
        for j in range(i + 3, min(len(text), i + 6) + 1):
            if ok(text[i:j]):
                search(j, acc + [(i, j)])
    search(0, [])
    return [chars[i:j] for i, j in best] if best else [chars]


def text_label(chars, sp):
    text = ''.join(chr(c[0]) for c in chars).strip()
    digits = text.replace(',', '')
    if not digits.isdigit():
        return None
    boxes = [c[3] for c in chars]
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    x1, y1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
    dx, dy = sp['dir']
    problems = []
    if not text.endswith('00'):
        problems.append('not rounded to 100')
    if int(digits) > MAX_VOLUME:
        problems.append('implausibly large: two labels run together?')
    return {'text': text, 'value': int(digits), 'theta': math.atan2(dy, dx),
            'x': (x0 + x1) / 2, 'y': (y0 + y1) / 2, 'bbox': (x0, y0, x1, y1),
            'problems': problems, 'seq': sp['seqno']}


# ------------------------------------------------------------ inset frame
def inset_frame(drawings, page):
    """The white background of the bottom-right inset, and its draw order."""
    pw, ph = page.rect.width, page.rect.height
    cands = [x for x in drawings if x['type'] in ('f', 'fs') and rgb2(x.get('fill')) == (1.0, 1.0, 1.0)
             and x['rect'].width > 300 and x['rect'].height > 300
             and x['rect'].x0 > pw * 0.5 and x['rect'].y0 > ph * 0.5]
    if not cands:
        return None, None
    x = max(cands, key=lambda d: d['seqno'])
    r = x['rect']
    return (r.x0, r.y0, r.x1, r.y1), x['seqno']


# --------------------------------------------------------------- georef
def reference_utm(path):
    """2019 extraction -> densified UTM points (metres)."""
    fc = json.load(open(path, encoding='utf-8'))
    to_utm = Transformer.from_crs(4326, UTM, always_xy=True)
    pts = []
    for f in fc['features']:
        g = f['geometry']
        parts = [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
        for line in parts:
            xs, ys = to_utm.transform([c[0] for c in line], [c[1] for c in line])
            pts += densify(list(zip(xs, ys)), 10.0)
    return np.array(pts)


def fit_page_to_utm(pieces, ref, s_lo=6.0, s_hi=24.0):
    """Similarity page (y down) -> UTM: E = a x - b y + tx, N = -b x - a y + ty
    (a = s cos r, b = s sin r). FFT over scale for a start, then ICP."""
    R = 20.0                                       # metres per raster pixel
    e0, n0 = ref.min(0) - 2000
    e1, n1 = ref.max(0) + 2000
    W, H = int((e1 - e0) / R), int((n1 - n0) / R)
    img = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(img)
    for e, n in ref:
        d.point(((e - e0) / R, (n1 - n) / R), fill=255)
    M = ndimage.gaussian_filter((np.asarray(img) > 0).astype(np.float32), 1.5)

    src = np.array([q for p in pieces for q in densify(p['pts'], 2.0)])
    px0, py0 = src.min(0)

    def corr(s):
        w = int((src[:, 0].max() - px0) * s / R) + 4
        h = int((src[:, 1].max() - py0) * s / R) + 4
        k = Image.new('L', (w, h), 0)
        kd = ImageDraw.Draw(k)
        for p in pieces:
            kd.line([((x - px0) * s / R, (y - py0) * s / R) for x, y in p['pts']], fill=255, width=1)
        K = (np.asarray(k) > 0).astype(np.float32)
        if K.shape[0] >= M.shape[0] or K.shape[1] >= M.shape[1]:
            return -1, 0, 0
        C = signal.fftconvolve(M, K[::-1, ::-1], mode='valid')
        i = np.unravel_index(np.argmax(C), C.shape)
        return C[i] / K.sum(), i[1], i[0]

    best = max(((*corr(s), s) for s in np.arange(s_lo, s_hi, 0.25)), key=lambda r: r[0])
    s0 = best[3]
    best = max(((*corr(s), s) for s in np.arange(s0 - 0.25, s0 + 0.26, 0.02)), key=lambda r: r[0])
    score, ix, iy, s = best
    # page (x, y) -> UTM: E = e0 + ix*R + (x - px0) s ; N = n1 - iy*R - (y - py0) s
    a, b = s, 0.0
    tx = e0 + ix * R - px0 * s
    ty = n1 - iy * R + py0 * s

    tree = cKDTree(ref)
    sample = src[::2]

    def apply(P, a, b, tx, ty):
        return np.c_[a * P[:, 0] - b * P[:, 1] + tx, -b * P[:, 0] - a * P[:, 1] + ty]

    for _ in range(40):
        mapped = apply(sample, a, b, tx, ty)
        dist, idx = tree.query(mapped)
        keep = dist < max(np.quantile(dist, 0.6), 15)
        P, Q = sample[keep], ref[idx[keep]]
        # Least squares for [a, b, tx, ty]:
        #   E = a x - b y + tx ;  N = -b x - a y + ty
        A = np.zeros((2 * len(P), 4))
        A[0::2] = np.c_[P[:, 0], -P[:, 1], np.ones(len(P)), np.zeros(len(P))]
        A[1::2] = np.c_[-P[:, 1], -P[:, 0], np.zeros(len(P)), np.ones(len(P))]
        rhs = np.empty(2 * len(P))
        rhs[0::2], rhs[1::2] = Q[:, 0], Q[:, 1]
        a, b, tx, ty = np.linalg.lstsq(A, rhs, rcond=None)[0]
    dist, _ = tree.query(apply(sample, a, b, tx, ty))
    to_ll = Transformer.from_crs(UTM, 4326, always_xy=True)

    def f(x, y):
        lon, lat = to_ll.transform(a * x - b * y + tx, -b * x - a * y + ty)
        return (round(lon, 6), round(lat, 6))
    info = {'metres_per_pt': math.hypot(a, b), 'rotation_deg': math.degrees(math.atan2(b, a)),
            'correlation': float(score), 'median_m': float(np.median(dist)),
            'within_25m': float((dist < 25).mean())}
    return f, info


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('out')
    ap.add_argument('--year', type=int, required=True)
    ap.add_argument('--reference', required=True, help='a georeferenced extraction (2019) to fit onto')
    ap.add_argument('--review')
    a = ap.parse_args()

    page = fitz.open(a.pdf)[0]
    drawings = page.get_drawings()
    pieces, kind = load_pieces_old(drawings)
    labels = load_text_labels(page)
    inset, inset_seq = inset_frame(drawings, page)
    print(f'{len(pieces)} line pieces ({kind}), {len(labels)} labels, inset {"found" if inset else "none"}')

    in_inset = (lambda pt, seq: inset is not None and seq > inset_seq and E.inside(pt, inset))
    main_pieces = [p for p in pieces if not in_inset(E.mid(p['pts']), p['seq'])]
    inset_pieces = [p for p in pieces if in_inset(E.mid(p['pts']), p['seq'])]

    to_ll, info = fit_page_to_utm(main_pieces, reference_utm(a.reference))
    print('georeference: {metres_per_pt:.2f} m/pt, rotation {rotation_deg:.2f} deg, '
          'median {median_m:.1f} m from the reference lines, {within_25m:.0%} within 25 m'.format(**info))
    if info['median_m'] > 15:
        sys.exit('georeference is poor (median > 15 m): check before using this year')

    to_main = lambda x, y: (x, y)
    covered = None
    if inset_pieces:
        s, tx, ty, score, med, _ = fit_inset(main_pieces, inset_pieces, inset, page.rect.width, page.rect.height)
        print(f'inset fit: scale {s:.5f}, correlation {score:.2f}, median offset {med:.2f} pt')
        if med > 0.8:
            sys.exit('inset fit is poor')
        to_main = lambda x, y: (s * x + tx, s * y + ty)
        covered = (*to_main(inset[0], inset[1]), *to_main(inset[2], inset[3]))

    for l in labels:
        l['zone'] = 'inset' if in_inset((l['x'], l['y']), l['seq']) else (
            'covered' if covered and E.inside((l['x'], l['y']), covered) else 'main')
    for p in pieces:
        m = E.mid(p['pts'])
        p['zone'] = 'inset' if in_inset(m, p['seq']) else (
            'covered' if covered and E.inside(m, covered) else 'main')
    labels = [l for l in labels if l['zone'] != 'covered']

    owner = {}
    for zone in ('main', 'inset'):
        zl = [l for l in labels if l['zone'] == zone]
        zp = [p for p in pieces if p['zone'] == zone]
        if zl and zp:
            # Measured widths (2012) are noisy, and its thick fills sit labels
            # further from the centreline: loosen both for that drawing style.
            opts = {'w_tol': 1.0, 'max_label_dist': 24.0} if kind.startswith('black') else {}
            for pi, li in E.assign(zl, zp, **opts).items():
                owner[id(zp[pi])] = zl[li]

    by_w = collections.defaultdict(list)
    for p in pieces:
        l = owner.get(id(p))
        if l:
            by_w[p['w']].append(l['value'])
    width_est = {w: sorted(v)[len(v) // 2] for w, v in by_w.items()}

    def estimate(w):
        return int(round(width_est[min(width_est, key=lambda k: abs(k - w))], -2))

    feats, n_est = [], 0
    for p in pieces:
        if p['zone'] == 'covered':
            continue
        pts = [to_main(*q) for q in p['pts']] if p['zone'] == 'inset' else p['pts']
        l = owner.get(id(p))
        if l:
            props = {'volume': l['value'], 'exact': 1, 'section': f"{l['zone']}:{l['x']:.1f}:{l['y']:.1f}"}
        else:
            props = {'volume': estimate(p['w']), 'exact': 0, 'section': None}
            n_est += 1
        feats.append({'type': 'Feature',
                      'geometry': {'type': 'LineString', 'coordinates': [to_ll(*q) for q in pts]},
                      'properties': props})
    merged = E.merge_sections(feats)
    unplaced = [l for l in labels if l.get('piece') is None]
    stats = (f"{len(labels)} labels read, {sum(1 for l in labels if l['problems'])} with a problem, "
             f"{len(unplaced)} not tied to a line; {len(feats)} line pieces, {n_est} reached by no label "
             f"(volume estimated from line width). Georeferenced onto the 2019 map: median "
             f"{info['median_m']:.1f} m.")
    fc = {'type': 'FeatureCollection',
          'metadata': {'source': f'City of Winnipeg {a.year} Traffic Flow Map (Public Works, Transportation Division)',
                       'measure': 'Average weekday daily traffic, both directions combined',
                       'year': a.year, 'extracted': stats,
                       'georeference': 'fitted onto the 2019 extraction (no georeferencing in the PDF)'},
          'features': merged}
    with open(a.out, 'w', encoding='utf-8') as fh:
        json.dump(fc, fh, separators=(',', ':'))
    print(stats)
    print(f'wrote {a.out}: {len(merged)} features')
    if a.review:
        E.write_review(a.review, page, labels, stats, a.year)
        print('review page:', a.review)


if __name__ == '__main__':
    main()
