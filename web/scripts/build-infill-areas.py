#!/usr/bin/env python
"""
build-infill-areas.py
---------------------------------------------------------------
Builds web/public/infill-guideline-areas.geojson: the City's six
Infill Guideline Area layers from the legacy PP&D Property Map
(legacy.winnipeg.ca/ppd/Mapping/PropertyMap), as one GeoJSON with a
feature per class:

    Infill Guideline Area 1                     (fsid 17939)
    Infill Guideline Area 1 (Airport PDO)       (fsid 17965)
    Infill Guideline Area 1 (Secondary Plan)    (fsid 17966)
    Infill Guideline Area 2                     (fsid 17964)
    Infill Guideline Area 2 (Airport PDO)       (fsid 17967)
    Infill Guideline Area 2 (Secondary Plan)    (fsid 17968)

WHY A RASTER TRACE. Open Data publishes only the outer "Mature
Community" boundary (5guk-f7xw), not the Area 1 / Area 2 split that
decides which Residential Infill Guidelines apply. The legacy map has
the split, but these six feature sets are served by the City map API
as WMS only (serviceType "wms"): wfs.ashx returns no vector items at
any scale. tile.ashx renders them as a 4-bit palette PNG in which each
class has one exact fill colour and one exact outline colour, so the
image classifies losslessly and can be traced back to polygons. This
script fetches the whole infill extent at ~1.1 m/pixel, classifies,
mosaics, polygonizes with GDAL, drops slivers and simplifies to ~1.5 m.
The result is an approximation of the City's polygons to about one
pixel; the popup in the app says so.

RUNS UNDER THE OSGeo4W PYTHON, which has GDAL + numpy and no PIL:
    "C:\\OSGeo4W\\apps\\Python312\\python.exe" -I web\\scripts\\build-infill-areas.py
It is invoked quarterly by r\\refresh_assets.ps1 (non-fatal there).
No other dependencies. Network: ~260 small PNG requests, a few minutes.

GEOREFERENCING. Each tile is requested with a lat/lng BBOX and drawn
by the City as a Google Maps GroundOverlay, i.e. in Web Mercator; over
a 0.01-degree-tall tile the departure from an equirectangular grid is
far below one pixel, so tiles are placed on a plain EPSG:4326 grid.
---------------------------------------------------------------
"""
import json
import os
import sys
import time
import urllib.request

import numpy as np
from osgeo import gdal, ogr, osr

gdal.UseExceptions()

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', 'public', 'infill-guideline-areas.geojson'))

WMS = 'https://mapapi.winnipeg.ca/mapapi/tile.ashx'
REFERER = 'https://legacy.winnipeg.ca/ppd/Mapping/PropertyMap/default.stm'
APP_ID = 8

# class id -> (fsid, area, variant, fill hex, outline hex) in the City's own colours.
CLASSES = {
    1: (17939, 1, 'Plain',          'EFF452', '9D9A1A'),
    2: (17965, 1, 'Airport PDO',    'F4D452', '9D8A1A'),
    3: (17966, 1, 'Secondary Plan', 'F49352', '9D4E1A'),
    4: (17964, 2, 'Plain',          'BC8DF4', 'A21DF0'),
    5: (17967, 2, 'Airport PDO',    'EB8DF4', 'EA1DF0'),
    6: (17968, 2, 'Secondary Plan', '998DF4', '4D1DF0'),
}
FIDS = ','.join(str(c[0]) for c in CLASSES.values())

# Whole-city search box for the coarse extent pass (N, S, W, E).
CITY = (50.00, 49.70, -97.35, -96.95)
# Detail tiles: 0.01 deg lat x 0.0155 deg lon at 1000 x 1000 px, which is
# ~1.1 m square pixels at Winnipeg's latitude.
TILE_LAT, TILE_LON, TILE_PX = 0.010, 0.0155, 1000
# Anything smaller than this after polygonizing is a tracing artefact, not
# an infill area (the smallest real pieces are whole blocks).
MIN_AREA_M2 = 400.0
SIMPLIFY_DEG = 0.000015   # ~1.5 m


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def fetch_png(n, s, w, e, width, height, scale):
    url = (f'{WMS}?cache=0&BBOX={n:.6f},{e:.6f},{s:.6f},{w:.6f}'
           f'&WIDTH={width}&HEIGHT={height}&scale={scale}&FIDs={FIDS}&aid={APP_ID}')
    req = urllib.request.Request(url, headers={'Referer': REFERER, 'User-Agent': 'wpg-parcelsearch-builder'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            if not data.startswith(b'\x89PNG'):
                raise RuntimeError('not a PNG')
            return data
        except Exception as err:  # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))
            print(f'  retry {attempt + 1}: {err}', file=sys.stderr)


def png_to_rgba(data):
    path = '/vsimem/tile.png'
    gdal.FileFromMemBuffer(path, data)
    try:
        ds = gdal.Open(path)
        arr = ds.ReadAsArray()  # palette PNGs come back as one band
        if arr.ndim == 2:
            ct = ds.GetRasterBand(1).GetRasterColorTable()
            lut = np.zeros((256, 4), dtype=np.uint8)
            for i in range(ct.GetCount()):
                lut[i] = ct.GetColorEntry(i)
            rgba = lut[arr]
        else:
            rgba = np.transpose(arr, (1, 2, 0))
            if rgba.shape[2] == 3:
                rgba = np.dstack([rgba, np.full(rgba.shape[:2], 255, np.uint8)])
        return rgba
    finally:
        gdal.Unlink(path)


# Nearest-colour lookup table over fills and outlines -> class id.
PALETTE = []
for cid, (_, _, _, fill, line) in CLASSES.items():
    PALETTE.append((hex_rgb(fill), cid))
    PALETTE.append((hex_rgb(line), cid))
PAL_RGB = np.array([p[0] for p in PALETTE], dtype=np.int32)
PAL_CID = np.array([p[1] for p in PALETTE], dtype=np.uint8)


def classify(rgba):
    rgb = rgba[:, :, :3].astype(np.int32)
    alpha = rgba[:, :, 3]
    d = ((rgb[:, :, None, :] - PAL_RGB[None, None, :, :]) ** 2).sum(axis=3)
    cls = PAL_CID[d.argmin(axis=2)]
    cls[alpha == 0] = 0
    return cls


def coarse_extent():
    n, s, w, e = CITY
    width, height = 1600, 1200
    rgba = png_to_rgba(fetch_png(n, s, w, e, width, height, 50000))
    on = rgba[:, :, 3] > 0
    ys, xs = np.nonzero(on)
    if ys.size == 0:
        raise RuntimeError('coarse pass found no infill pixels - WMS changed?')
    lat_px = (n - s) / height
    lon_px = (e - w) / width
    top = n - ys.min() * lat_px
    bottom = n - (ys.max() + 1) * lat_px
    left = w + xs.min() * lon_px
    right = w + (xs.max() + 1) * lon_px
    pad = 0.005
    return top + pad, bottom - pad, left - pad, right + pad


def build_mosaic(top, bottom, left, right):
    rows = int(np.ceil((top - bottom) / TILE_LAT))
    cols = int(np.ceil((right - left) / TILE_LON))
    mosaic = np.zeros((rows * TILE_PX, cols * TILE_PX), dtype=np.uint8)
    total = rows * cols
    print(f'  {rows} x {cols} = {total} tiles at {TILE_PX}px')
    k = 0
    for r in range(rows):
        n = top - r * TILE_LAT
        s = n - TILE_LAT
        for c in range(cols):
            w = left + c * TILE_LON
            e = w + TILE_LON
            k += 1
            cls = classify(png_to_rgba(fetch_png(n, s, w, e, TILE_PX, TILE_PX, 1000)))
            mosaic[r * TILE_PX:(r + 1) * TILE_PX, c * TILE_PX:(c + 1) * TILE_PX] = cls
            if k % 25 == 0 or k == total:
                print(f'  tile {k}/{total}')
    geotransform = (left, TILE_LON / TILE_PX, 0.0, top, 0.0, -TILE_LAT / TILE_PX)
    return mosaic, geotransform


def polygonize(mosaic, geotransform):
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(4326)
    drv = gdal.GetDriverByName('MEM')
    ds = drv.Create('', mosaic.shape[1], mosaic.shape[0], 1, gdal.GDT_Byte)
    ds.SetGeoTransform(geotransform)
    ds.SetProjection(srs.ExportToWkt())
    band = ds.GetRasterBand(1)
    band.WriteArray(mosaic)
    mask = drv.Create('', mosaic.shape[1], mosaic.shape[0], 1, gdal.GDT_Byte)
    mask.GetRasterBand(1).WriteArray((mosaic > 0).astype(np.uint8))

    vds = ogr.GetDriverByName('MEM').CreateDataSource('polys')
    lyr = vds.CreateLayer('polys', srs, ogr.wkbPolygon)
    lyr.CreateField(ogr.FieldDefn('cls', ogr.OFTInteger))
    gdal.Polygonize(band, mask.GetRasterBand(1), lyr, 0, ['8CONNECTED=8'])

    by_class = {cid: [] for cid in CLASSES}
    dropped = 0
    # m^2 per deg^2 at this latitude, for the sliver filter.
    lat0 = geotransform[3] + geotransform[5] * mosaic.shape[0] / 2
    m2_per_deg2 = (111_320.0 ** 2) * np.cos(np.radians(lat0))
    for feat in lyr:
        cid = feat.GetField('cls')
        geom = feat.GetGeometryRef().Clone()
        if geom.GetArea() * m2_per_deg2 < MIN_AREA_M2:
            dropped += 1
            continue
        geom = geom.SimplifyPreserveTopology(SIMPLIFY_DEG)
        if geom is None or geom.IsEmpty():
            dropped += 1
            continue
        by_class[cid].append(geom)
    print(f'  polygons kept: {sum(len(v) for v in by_class.values())}, slivers dropped: {dropped}')
    return by_class


def to_feature(cid, geoms):
    fsid, area, variant, fill, line = CLASSES[cid]
    multi = ogr.Geometry(ogr.wkbMultiPolygon)
    for g in geoms:
        if g.GetGeometryType() in (ogr.wkbPolygon, ogr.wkbPolygon25D):
            multi.AddGeometry(g)
        else:
            for i in range(g.GetGeometryCount()):
                multi.AddGeometry(g.GetGeometryRef(i))
    coords = json.loads(multi.ExportToJson())['coordinates']
    # Round to 1e-6 deg (~7 cm): below the trace precision, keeps the file small.
    coords = [[[[round(x, 6), round(y, 6)] for x, y in ring] for ring in poly] for poly in coords]
    title = f'Infill Guideline Area {area}' + ('' if variant == 'Plain' else f' ({variant})')
    return {
        'type': 'Feature',
        'properties': {
            'area': area, 'variant': variant, 'title': title,
            'feature_set_id': fsid, 'fill': f'#{fill.lower()}', 'line': f'#{line.lower()}',
            'polygons': len(coords),
        },
        'geometry': {'type': 'MultiPolygon', 'coordinates': coords},
    }


def write_stable(path, fc):
    nxt = json.dumps(fc, separators=(',', ':'))

    def norm(t):
        import re
        return re.sub(r'"generated_at":"[^"]*"', '"generated_at":"<normalized>"', t)
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            prev = f.read()
        if norm(prev) == norm(nxt):
            return 'unchanged'
        reason = 'changed'
    else:
        reason = 'new'
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(nxt)
    return reason


def main():
    print('Coarse extent pass ...')
    top, bottom, left, right = coarse_extent()
    print(f'  infill extent lat {bottom:.4f}..{top:.4f} lon {left:.4f}..{right:.4f}')
    print('Fetching detail tiles ...')
    mosaic, gt = build_mosaic(top, bottom, left, right)
    counts = {cid: int((mosaic == cid).sum()) for cid in CLASSES}
    print('  pixels per class:', counts)
    if sum(counts.values()) == 0:
        raise RuntimeError('no classified pixels - refusing to write')
    print('Polygonizing ...')
    by_class = polygonize(mosaic, gt)
    features = [to_feature(cid, geoms) for cid, geoms in by_class.items() if geoms]
    fc = {
        'type': 'FeatureCollection',
        '_meta': {
            'source': 'City of Winnipeg map API WMS (tile.ashx), feature sets 17939/17965/17966/17964/17967/17968, as drawn on the legacy PP&D Property Map',
            'source_url': 'https://legacy.winnipeg.ca/ppd/Mapping/PropertyMap/default.stm',
            'method': f'raster trace at ~{111320 * TILE_LAT / TILE_PX:.1f} m/pixel, polygonized and simplified to ~{SIMPLIFY_DEG * 111320:.1f} m; approximate to about one pixel',
            'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        },
        'features': features,
    }
    for f in features:
        print(f"  {f['properties']['title']}: {f['properties']['polygons']} polygons")
    print(f'  {os.path.basename(OUT)}: {write_stable(OUT, fc)}')


if __name__ == '__main__':
    try:
        main()
    except Exception as err:  # noqa: BLE001
        print(f'ERROR: {err}', file=sys.stderr)
        sys.exit(1)
