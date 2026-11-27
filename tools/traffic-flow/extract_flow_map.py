"""
Extract the City of Winnipeg Traffic Flow Map (24-hour average weekday
traffic, the yearly PDF from Public Works) into GeoJSON for the Traffic
overlay.

    python extract_flow_map.py <flow-map.pdf> <out.geojson> [--year 2024] [--review review.html]

Needs PyMuPDF, pyproj, numpy, scipy and Pillow
(pip install pymupdf pyproj numpy scipy pillow). Built against the
2024 map (QGIS 3.40 export, published 2025-11-07); the 2019-2023 maps come
from the same QGIS project and should run unchanged, but check the review
page for each one.

HOW THE PDF IS BUILT, AND SO HOW THIS READS IT
  * It is a GeoPDF: the page's viewport carries /GPTS (lat/lon of the page
    corners) and EPSG 26914 (UTM 14N). The map fills the whole page, so
    page -> UTM is one affine transform fitted to the four corners.
  * Streets are green strokes (0, .671, .306); the stroke WIDTH is the
    volume (the legend runs 1,000 -> 70,000).
  * Volume labels are blue (0, .4, .608) text converted to outlines: one
    filled path per character, no text layer. Every character comes from
    one font, so each has a fixed number of path segments: that count IS
    the character (16 = 0, 12 = 1, 28 = 3, 24 = 5, 11 = 7, 34 = 8,
    13 = comma), except two pairs drawn from the same outline: 19 is 2 or
    4 and 26 is 6 or 9. Those are told apart by shape once the label is
    turned upright: a 4 has an inner counter and a 2 does not; a 6
    carries its closed loop low and a 9 high, measured along each glyph's
    own baseline (labels bend round curves). No OCR, so no OCR misreads.
  * A label is the run of characters around one comma. Upright = the
    rotation that puts the comma below the digits.
  * The central area is drawn twice: faintly on the main map, and at
    ~2.8x in the "Enlargement of Central Area" inset. The inset frame is
    not the "See Enlargement" box (it shows a little more), so the inset
    is fitted onto the main map by its green streets (inset_fit.py: FFT
    correlation for scale + shift, then ICP; median fit ~0.1 pt = 2 m).
    Inset labels and lines then replace the faint main-map lines inside
    the box.
  * Each green line piece takes the volume of the nearest parallel label
    whose value fits the piece's stroke width. Pieces with no such label
    keep a volume estimated from width alone and are flagged.

The review page lists every label with a crop of the PDF beside the value
read, failures first, so a new year can be checked in a couple of minutes.
"""

import argparse
import base64
import collections
import html
import io
import json
import math
import re
import sys

import fitz  # PyMuPDF
from pyproj import Transformer

from inset_fit import fit_inset

GREEN = (0.0, 0.671, 0.306)
BLUE = (0.0, 0.4, 0.608)
COMMA = 13
DIGIT_BY_COUNT = {16: '0', 12: '1', 28: '3', 24: '5', 11: '7', 34: '8'}
AMBIGUOUS = {19: ('2', '4'), 26: ('6', '9')}


def rgb(c):
    return tuple(round(v, 3) for v in c) if c else None


def rot(pt, th, ox, oy):
    """Rotate pt about (ox, oy) by -th: into a label's upright frame."""
    c, s = math.cos(-th), math.sin(-th)
    x, y = pt[0] - ox, pt[1] - oy
    return (x * c - y * s, x * s + y * c)


# --------------------------------------------------------------- glyphs
def load_glyphs(page):
    glyphs = []
    for x in page.get_drawings():
        if x['type'] != 'f' or rgb(x.get('fill')) != BLUE:
            continue
        pts, subpaths, prev = [], [], None
        for it in x['items']:
            if it[0] == 'l':
                seg = [(it[1].x, it[1].y), (it[2].x, it[2].y)]
            elif it[0] == 'c':
                seg = [(q.x, q.y) for q in it[1:]]
            else:
                continue
            # A new subpath starts where an item does not begin at the last end.
            if prev is None or abs(prev[0] - seg[0][0]) > 1e-3 or abs(prev[1] - seg[0][1]) > 1e-3:
                subpaths.append([])
            subpaths[-1] += seg
            pts += seg
            prev = seg[-1]
        r = x['rect']
        glyphs.append({'pts': pts, 'subpaths': subpaths, 'n': len(x['items']), 'cx': (r.x0 + r.x1) / 2,
                       'cy': (r.y0 + r.y1) / 2, 'rect': (r.x0, r.y0, r.x1, r.y1), 'seq': x['seqno']})
    return glyphs


def group_labels(glyphs, pad=2.2, maxd=5.2):
    n = len(glyphs)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    order = sorted(range(n), key=lambda i: glyphs[i]['rect'][0])
    for k, a in enumerate(order):
        ra = glyphs[a]['rect']
        for b in order[k + 1:]:
            rb = glyphs[b]['rect']
            if rb[0] > ra[2] + pad:
                break
            if rb[1] <= ra[3] + pad and rb[3] >= ra[1] - pad:
                if math.hypot(glyphs[a]['cx'] - glyphs[b]['cx'], glyphs[a]['cy'] - glyphs[b]['cy']) < maxd:
                    parent[find(a)] = find(b)
    groups = collections.defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)
    return list(groups.values())


def orient(gs):
    """Baseline angle (PCA of glyph centres), flipped so the comma is low."""
    pts = [(g['cx'], g['cy']) for g in gs]
    mx = sum(p[0] for p in pts) / len(pts)
    my = sum(p[1] for p in pts) / len(pts)
    if len(gs) >= 2:
        sxx = sum((p[0] - mx) ** 2 for p in pts)
        syy = sum((p[1] - my) ** 2 for p in pts)
        sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
        th = 0.5 * math.atan2(2 * sxy, sxx - syy)
    else:
        th = 0.0
    commas = [g for g in gs if g['n'] == COMMA]
    digits = [g for g in gs if g['n'] != COMMA] or gs
    if commas:
        def low(t):
            cy = lambda g: rot((g['cx'], g['cy']), t, mx, my)[1]
            return sum(map(cy, commas)) / len(commas) - sum(map(cy, digits)) / len(digits)
        if low(th) < low(th + math.pi):
            th += math.pi
    return th, mx, my, bool(commas)


def read_glyph(g, th):
    """One character. `th` is the glyph's own baseline angle (labels bend
    round curves, so each glyph is turned by its neighbours, not by the
    label's average)."""
    n = g['n']
    if n == COMMA:
        return ',', None
    if n in DIGIT_BY_COUNT:
        return DIGIT_BY_COUNT[n], None
    if n not in AMBIGUOUS:
        return '?', f'unknown glyph ({n} segments)'
    if n == 19:
        # A 4 has a counter (a second, inner outline); a 2 has none.
        return ('4' if len(g['subpaths']) >= 2 else '2'), None
    # 6 vs 9: same outline turned over. The closed loop (the smaller
    # subpath) sits low in a 6 and high in a 9, about a quarter of the
    # glyph height off centre, measured along the glyph's own "down".
    if len(g['subpaths']) < 2:
        return '?', '6/9 without a loop'
    def extent(sp):
        xs = [q[0] for q in sp]; ys = [q[1] for q in sp]
        return (max(xs) - min(xs)) * (max(ys) - min(ys))
    loop = min(g['subpaths'], key=extent)
    lx = sum(q[0] for q in loop) / len(loop)
    ly = sum(q[1] for q in loop) / len(loop)
    up = [rot(q, th, g['cx'], g['cy']) for q in g['pts']]
    ys = [q[1] for q in up]
    h = (max(ys) - min(ys)) or 1
    mid_y = (max(ys) + min(ys)) / 2
    off = (rot((lx, ly), th, g['cx'], g['cy'])[1] - mid_y) / h
    return ('6' if off > 0 else '9'), (f'6/9 loop offset {off:.2f}' if abs(off) < 0.08 else None)


def read_one(gs, th, mx, my):
    gs = sorted(gs, key=lambda g: rot((g['cx'], g['cy']), th, mx, my)[0])
    chars, doubts = [], []
    for i, g in enumerate(gs):
        a, b = gs[max(0, i - 1)], gs[min(len(gs) - 1, i + 1)]
        dx, dy = b['cx'] - a['cx'], b['cy'] - a['cy']
        local = math.atan2(dy, dx) if (dx or dy) else th
        if math.cos(local - th) < 0:
            local += math.pi
        ch, doubt = read_glyph(g, local)
        chars.append(ch)
        if doubt:
            doubts.append(doubt)
    return ''.join(chars), doubts


def read_labels(page):
    glyphs = load_glyphs(page)
    labels = []
    for idx in group_labels(glyphs):
        gs = [glyphs[i] for i in idx]
        th, mx, my, has_comma = orient(gs)
        text, doubts = read_one(gs, th, mx, my)
        if not has_comma and text.startswith('0'):
            # No comma to say which way is up (values under 1,000): a
            # number never starts with 0, so read it the other way round.
            th += math.pi
            text, doubts = read_one(gs, th, mx, my)
        problems = list(doubts)
        if not re.fullmatch(r'\d{1,3}(,\d{3})?', text):
            problems.append('not a number in n,nnn form')
        elif not text.endswith('00'):
            problems.append('not rounded to 100')
        value = int(text.replace(',', '')) if re.fullmatch(r'[\d,]+', text) else None
        pts = [p for g in gs for p in g['pts']]
        labels.append({'text': text, 'value': value, 'theta': th, 'x': mx, 'y': my,
                       'bbox': (min(p[0] for p in pts), min(p[1] for p in pts),
                                max(p[0] for p in pts), max(p[1] for p in pts)),
                       'problems': problems, 'seq': min(g['seq'] for g in gs)})
    return labels


# ---------------------------------------------------------- georeference
def page_to_lonlat(doc, page):
    """Affine page (PyMuPDF, y down) -> UTM from the GeoPDF corners, then
    UTM -> WGS84 lon/lat. Returns f(x, y) -> (lon, lat)."""
    gpts = lpts = epsg = bbox = None
    for k in range(1, doc.xref_length()):
        try:
            o = doc.xref_object(k)
        except Exception:
            continue
        m = re.search(r'/GPTS \[([^\]]+)\]', o)
        if m:
            gpts = [float(v) for v in m.group(1).split()]
            lpts = [float(v) for v in re.search(r'/LPTS \[([^\]]+)\]', o).group(1).split()]
        e = re.search(r'/EPSG (\d+)', o)
        if e:
            epsg = int(e.group(1))
        if '/Type /Viewport' in o:
            bbox = [float(v) for v in re.search(r'/BBox \[([^\]]+)\]', o).group(1).split()]
    if not gpts or not epsg or not bbox:
        sys.exit('not a GeoPDF: no viewport with /GPTS + /EPSG')
    bx0, by0, bx1, by1 = bbox
    ph = page.rect.height
    to_utm = Transformer.from_crs(4326, epsg, always_xy=True)
    to_ll = Transformer.from_crs(epsg, 4326, always_xy=True)
    src, dst = [], []
    for i in range(0, len(gpts), 2):
        lat, lon = gpts[i], gpts[i + 1]
        u, v = lpts[i], lpts[i + 1]
        src.append((bx0 + u * (bx1 - bx0), ph - (by0 + v * (by1 - by0))))
        dst.append(to_utm.transform(lon, lat))
    A = fit_affine(src, dst)
    worst = max(math.hypot(A[0] * x + A[1] * y + A[2] - e, A[3] * x + A[4] * y + A[5] - n)
                for (x, y), (e, n) in zip(src, dst))
    print(f'georeference: {epsg}, corner fit residual {worst:.1f} m')

    def f(x, y):
        lon, lat = to_ll.transform(A[0] * x + A[1] * y + A[2], A[3] * x + A[4] * y + A[5])
        return (round(lon, 6), round(lat, 6))
    return f


def fit_affine(src, dst):
    """Least-squares affine src -> dst: [a b c d e f] with
    E = a x + b y + c, N = d x + e y + f."""
    def solve(col):
        m = [[0.0] * 3 for _ in range(3)]
        r = [0.0] * 3
        for (x, y), t in zip(src, col):
            row = (x, y, 1.0)
            for i in range(3):
                r[i] += row[i] * t
                for j in range(3):
                    m[i][j] += row[i] * row[j]
        for i in range(3):
            piv = max(range(i, 3), key=lambda k: abs(m[k][i]))
            m[i], m[piv] = m[piv], m[i]
            r[i], r[piv] = r[piv], r[i]
            for k in range(i + 1, 3):
                fct = m[k][i] / m[i][i]
                for j in range(i, 3):
                    m[k][j] -= fct * m[i][j]
                r[k] -= fct * r[i]
        out = [0.0] * 3
        for i in (2, 1, 0):
            out[i] = (r[i] - sum(m[i][j] * out[j] for j in range(i + 1, 3))) / m[i][i]
        return out
    return solve([d[0] for d in dst]) + solve([d[1] for d in dst])


# ------------------------------------------------------------- frames
def frames(page):
    """(legend, inset, enlargement box, inset_seq): the three black 1.4 pt
    frames, plus the drawing-order number of the inset's white background.
    The legend is the top one; of the other two the inset is the larger.

    Drawing order matters: QGIS draws the WHOLE main map first, including
    the roads under where the inset will sit, then paints the inset's white
    background over them and draws the inset on top. So "inside the inset
    frame" is not enough to call something inset content; it must also be
    drawn after that background. Earlier things are main-map content at
    their true position (hidden in the PDF, but real roads)."""
    quads = []
    drawings = page.get_drawings()
    for x in drawings:
        if x['type'] == 's' and rgb(x.get('color')) == (0.0, 0.0, 0.0) and (x.get('width') or 0) > 1:
            r = x['rect']
            if r.width > 100 and r.height > 100:
                quads.append((r.x0, r.y0, r.x1, r.y1))
    if len(quads) != 3:
        sys.exit(f'expected 3 frames (legend, inset, enlargement box), found {len(quads)}: {quads}')
    quads.sort(key=lambda q: q[1])
    legend = quads[0]
    box, inset = sorted(quads[1:], key=lambda q: q[2] - q[0])
    bg = [x['seqno'] for x in drawings
          if x['type'] in ('f', 'fs') and rgb(x.get('fill')) == (1.0, 1.0, 1.0)
          and abs(x['rect'].x0 - inset[0]) < 2 and abs(x['rect'].y0 - inset[1]) < 2
          and abs(x['rect'].x1 - inset[2]) < 2 and abs(x['rect'].y1 - inset[3]) < 2]
    if not bg:
        sys.exit('no white background under the inset frame: cannot tell inset content from the main map')
    return legend, inset, box, max(bg)


def inside(pt, r):
    return r[0] <= pt[0] <= r[2] and r[1] <= pt[1] <= r[3]


# ------------------------------------------------------------- lines
def load_pieces(page):
    pieces = []
    for x in page.get_drawings():
        if x['type'] != 's' or rgb(x.get('color')) != GREEN:
            continue
        pts = []
        for it in x['items']:
            if it[0] == 'l':
                seg = [(it[1].x, it[1].y), (it[2].x, it[2].y)]
            elif it[0] == 'c':
                seg = [(it[1].x, it[1].y), (it[4].x, it[4].y)]
            else:
                seg = []
            for q in seg:
                if not pts or math.hypot(pts[-1][0] - q[0], pts[-1][1] - q[1]) > 1e-6:
                    pts.append(q)
        if len(pts) >= 2:
            pieces.append({'pts': pts, 'w': round(x.get('width') or 0, 2), 'seq': x['seqno']})
    return pieces


def seg_dist(px, py, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = dx * dx + dy * dy or 1e-12
    t = max(0.0, min(1.0, ((px - a[0]) * dx + (py - a[1]) * dy) / L))
    return math.hypot(px - a[0] - t * dx, py - a[1] - t * dy), math.atan2(dy, dx)


def angle_diff(a, b):
    """Undirected difference between two line angles, 0..pi/2."""
    return abs((a - b + math.pi / 2) % math.pi - math.pi / 2)


def length(pts):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))


def end_angle(pts, at_start):
    """Direction pointing from the end INTO the line."""
    if at_start:
        a, b = pts[0], pts[1]
    else:
        a, b = pts[-1], pts[-2]
    return math.atan2(b[1] - a[1], b[0] - a[0])


def assign(labels, pieces, max_label_dist=16.0, max_turn=math.radians(40)):
    """Seed each label on its nearest parallel piece, then spread each seed
    along connected pieces of the same stroke width that carry straight on
    (multi-source Dijkstra by drawn length, so a piece takes the nearest
    label along its own street). Returns {piece index: label index}."""
    import heapq
    seeds = {}
    for li, l in enumerate(labels):
        l['piece'] = None
        if l['value'] is None:
            continue
        best = None
        for pi, p in enumerate(pieces):
            for a, b in zip(p['pts'], p['pts'][1:]):
                d, ang = seg_dist(l['x'], l['y'], a, b)
                if d <= max_label_dist and angle_diff(ang, l['theta']) < 0.35 and (best is None or d < best[0]):
                    best = (d, pi)
        if best:
            l['piece'] = best[1]
            if best[1] not in seeds or best[0] < seeds[best[1]][0]:
                seeds[best[1]] = (best[0], li)

    key = lambda q: (round(q[0] / 0.4), round(q[1] / 0.4))
    ends = collections.defaultdict(list)
    for pi, p in enumerate(pieces):
        ends[key(p['pts'][0])].append((pi, True))
        ends[key(p['pts'][-1])].append((pi, False))

    owner, best_d, heap = {}, {}, []
    for pi, (_, li) in seeds.items():
        best_d[pi] = 0.0
        heapq.heappush(heap, (0.0, pi, li))
    while heap:
        d, pi, li = heapq.heappop(heap)
        if pi in owner:
            continue
        owner[pi] = li
        p = pieces[pi]
        for at_start in (True, False):
            node = key(p['pts'][0] if at_start else p['pts'][-1])
            back = end_angle(p['pts'], at_start)       # from the junction back into p
            for qi, q_start in ends[node]:
                if qi == pi or qi in owner or pieces[qi]['w'] != p['w']:
                    continue
                fwd = end_angle(pieces[qi]['pts'], q_start)   # from the junction into q
                # Carrying straight on, q leaves opposite to the way p came in.
                turn = abs(((fwd - back) % (2 * math.pi)) - math.pi)
                if turn > max_turn:
                    continue
                nd = d + length(pieces[qi]['pts'])
                if nd < best_d.get(qi, float('inf')):
                    best_d[qi] = nd
                    heapq.heappush(heap, (nd, qi, li))
    return owner


# --------------------------------------------------------------- review
def label_crop(page, l):
    x0, y0, x1, y1 = l['bbox']
    clip = fitz.Rect(x0 - 6, y0 - 6, x1 + 6, y1 + 6)
    return base64.b64encode(page.get_pixmap(dpi=300, clip=clip).tobytes('png')).decode()


def write_review(path, page, labels, stats, year):
    rows = sorted(labels, key=lambda l: (not l['problems'], l.get('piece') is not None, -(l['value'] or 0)))
    out = [f"""<!doctype html><meta charset="utf-8"><title>Flow map {year} review</title>
<style>body{{font:14px system-ui;margin:16px}}table{{border-collapse:collapse}}
td,th{{border-bottom:1px solid #ddd;padding:4px 8px;text-align:left}}
.bad{{background:#fff1f2}}.warn{{background:#fffbeb}}img{{max-height:46px}}</style>
<h1>Traffic Flow Map {year}: label check</h1>
<p>{html.escape(stats)}</p>
<p>Compare each crop with the value read. Rows with a problem, or not tied to a line, come first.</p>
<table><tr><th>Crop of the PDF</th><th>Read</th><th>On a line</th><th>Notes</th></tr>"""]
    for l in rows:
        cls = 'bad' if l['problems'] else ('warn' if l.get('piece') is None else '')
        out.append(f"<tr class='{cls}'><td><img src='data:image/png;base64,{label_crop(page, l)}'></td>"
                   f"<td><b>{html.escape(l['text'])}</b></td><td>{'yes' if l.get('piece') is not None else 'NO'}</td>"
                   f"<td>{html.escape('; '.join(l['problems']))}</td></tr>")
    out.append('</table>')
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(out))


# ----------------------------------------------------------------- main
def mid(pts):
    return pts[len(pts) // 2]


def chain(lines, tol=2e-5):
    """Join polylines that share an endpoint (within tol degrees, ~2 m)
    into as few continuous lines as possible. Greedy, which is plenty for
    the few pieces in one section."""
    lines = [list(l) for l in lines]
    close = lambda a, b: abs(a[0] - b[0]) < tol and abs(a[1] - b[1]) < tol
    merged = True
    while merged and len(lines) > 1:
        merged = False
        for i in range(len(lines)):
            for j in range(len(lines)):
                if i == j:
                    continue
                a, b = lines[i], lines[j]
                if close(a[-1], b[0]):
                    lines[i] = a + b[1:]
                elif close(a[-1], b[-1]):
                    lines[i] = a + b[::-1][1:]
                elif close(a[0], b[-1]):
                    lines[i] = b + a[1:]
                elif close(a[0], b[0]):
                    lines[i] = b[::-1] + a[1:]
                else:
                    continue
                del lines[j]
                merged = True
                break
            if merged:
                break
    return lines


def merge_sections(feats):
    """One feature per labelled section with its pieces chained into
    continuous lines, so the map labels a run once rather than once per
    drawn piece; estimated pieces are chained by (width-class) volume too."""
    groups = collections.OrderedDict()
    for f in feats:
        s = f['properties'].pop('section') or f"est:{f['properties']['volume']}"
        groups.setdefault(s, []).append(f)
    out = []
    for fs in groups.values():
        parts = chain([f['geometry']['coordinates'] for f in fs])
        geom = ({'type': 'LineString', 'coordinates': parts[0]} if len(parts) == 1
                else {'type': 'MultiLineString', 'coordinates': parts})
        out.append({'type': 'Feature', 'geometry': geom, 'properties': dict(fs[0]['properties'])})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('out')
    ap.add_argument('--year', type=int, required=True)
    ap.add_argument('--review')
    a = ap.parse_args()
    doc = fitz.open(a.pdf)
    page = doc[0]
    to_ll = page_to_lonlat(doc, page)
    legend, inset, box, inset_seq = frames(page)
    in_inset = lambda pt, seq: seq > inset_seq and inside(pt, inset)
    # The inset frame is NOT the enlargement box (the inset shows a little
    # more, offset ~16 pt), so the frames only seed the scale; the fit
    # overlays the inset's green streets onto the main map's.
    all_pieces = load_pieces(page)
    s, tx, ty, score, med, p60 = fit_inset(
        [p for p in all_pieces if not in_inset(mid(p['pts']), p['seq']) and not inside(mid(p['pts']), legend)],
        [p for p in all_pieces if in_inset(mid(p['pts']), p['seq'])],
        inset, page.rect.width, page.rect.height)
    print(f'inset fit: scale {s:.5f}, correlation {score:.2f}, median offset {med:.2f} pt')
    if med > 0.6:
        sys.exit('inset fit is poor (median offset > 0.6 pt): check the review overlay before using this year')
    to_main = lambda x, y: (s * x + tx, s * y + ty)
    # Where the inset lands on the main map. Main-map pieces under it are
    # the faint copy (and the box margin): the inset's own pieces replace them.
    covered = (*to_main(inset[0], inset[1]), *to_main(inset[2], inset[3]))

    labels =[l for l in read_labels(page) if not inside((l['x'], l['y']), legend)]
    pieces = [p for p in all_pieces if not inside(mid(p['pts']), legend)]
    for l in labels:
        l['zone'] = 'inset' if in_inset((l['x'], l['y']), l['seq']) else (
            'covered' if inside((l['x'], l['y']), covered) else 'main')
    for p in pieces:
        m = mid(p['pts'])
        p['zone'] = 'inset' if in_inset(m, p['seq']) else ('covered' if inside(m, covered) else 'main')
    labels = [l for l in labels if l['zone'] != 'covered']

    owner = {}
    for zone in ('main', 'inset'):
        zl = [l for l in labels if l['zone'] == zone]
        zp = [p for p in pieces if p['zone'] == zone]
        for pi, li in assign(zl, zp).items():
            owner[id(zp[pi])] = zl[li]

    # Stroke-width class -> median labelled value, for pieces no label reached.
    by_w = collections.defaultdict(list)
    for p in pieces:
        l = owner.get(id(p))
        if l and l['value']:
            by_w[p['w']].append(l['value'])
    width_est = {w: sorted(v)[len(v) // 2] for w, v in by_w.items()}

    def estimate(w):
        near = min(width_est, key=lambda k: abs(k - w))
        return int(round(width_est[near], -2))

    feats, n_est = [], 0
    for p in pieces:
        if p['zone'] == 'covered':
            continue                      # the main-map copy under the inset
        pts = [to_main(*q) for q in p['pts']] if p['zone'] == 'inset' else p['pts']
        l = owner.get(id(p))
        if l and l['value']:
            props = {'volume': l['value'], 'exact': 1, 'section': f"{l['zone']}:{l['x']:.1f}:{l['y']:.1f}"}
        else:
            props = {'volume': estimate(p['w']), 'exact': 0, 'section': None}
            n_est += 1
        feats.append({'type': 'Feature',
                      'geometry': {'type': 'LineString', 'coordinates': [to_ll(*q) for q in pts]},
                      'properties': props})
    merged = merge_sections(feats)
    unplaced = [l for l in labels if l.get('piece') is None]
    stats = (f"{len(labels)} labels read, {sum(1 for l in labels if l['problems'])} with a problem, "
             f"{len(unplaced)} not tied to a line; {len(feats)} line pieces, {n_est} reached by no label "
             f"(volume estimated from line width).")
    fc = {'type': 'FeatureCollection',
          'metadata': {'source': f'City of Winnipeg {a.year} Traffic Flow Map (Public Works, Transportation Division)',
                       'measure': 'Average weekday daily traffic, both directions combined; provincial roads are '
                                  'Manitoba Transportation and Infrastructure annual average daily traffic',
                       'year': a.year, 'extracted': stats},
          'features': merged}
    with open(a.out, 'w', encoding='utf-8') as fh:
        json.dump(fc, fh, separators=(',', ':'))
    print(stats)
    print(f'wrote {a.out}: {len(merged)} features')
    if a.review:
        write_review(a.review, page, labels, stats, a.year)
        print('review page:', a.review)


if __name__ == '__main__':
    main()
