"""Fit the central-area inset onto the main map: FFT correlation over a
scale range for a coarse scale + shift, then trimmed ICP. Both maps are
north-up, so the transform is scale + translation (no rotation)."""
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage, signal
from scipy.spatial import cKDTree


def densify(pts, step=0.5):
    out = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(1, int(np.hypot(x1 - x0, y1 - y0) / step))
        for k in range(n):
            t = k / n
            out.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
    out.append(pts[-1])
    return out


def fit_inset(main_pieces, inset_pieces, inset, page_w, page_h, s_lo=0.25, s_hi=0.8):
    img = Image.new('L', (int(page_w), int(page_h)), 0)
    d = ImageDraw.Draw(img)
    for p in main_pieces:
        d.line(p['pts'], fill=255, width=2)
    M = ndimage.gaussian_filter((np.asarray(img) > 0).astype(np.float32), 1.0)

    def corr(s):
        w = int((inset[2] - inset[0]) * s) + 4
        h = int((inset[3] - inset[1]) * s) + 4
        im = Image.new('L', (w, h), 0)
        dd = ImageDraw.Draw(im)
        for p in inset_pieces:
            dd.line([((x - inset[0]) * s, (y - inset[1]) * s) for x, y in p['pts']], fill=255, width=1)
        K = (np.asarray(im) > 0).astype(np.float32)
        C = signal.fftconvolve(M, K[::-1, ::-1], mode='valid')
        i = np.unravel_index(np.argmax(C), C.shape)
        return C[i] / K.sum(), i[1], i[0]

    best = max(((*corr(s), s) for s in np.arange(s_lo, s_hi, 0.01)), key=lambda r: r[0])
    s0 = best[3]
    best = max(((*corr(s), s) for s in np.arange(s0 - 0.01, s0 + 0.0101, 0.001)), key=lambda r: r[0])
    score, tx, ty, s = best
    tx, ty = tx - inset[0] * s, ty - inset[1] * s      # x' = s x + tx

    tree = cKDTree(np.array([q for p in main_pieces for q in densify(p['pts'])]))
    src = np.array([q for p in inset_pieces for q in densify(p['pts'], 2.0)])
    for _ in range(30):
        mapped = src * s + [tx, ty]
        dist, idx = tree.query(mapped)
        keep = dist < np.quantile(dist, 0.6)
        q, c = src[keep], tree.data[idx[keep]]
        qm, cm = q.mean(0), c.mean(0)
        s = ((q - qm) * (c - cm)).sum() / ((q - qm) ** 2).sum()
        tx, ty = cm - s * qm
    dist, _ = tree.query(src * s + [tx, ty])
    return s, tx, ty, float(score), float(np.median(dist)), float(np.quantile(dist, 0.6))
