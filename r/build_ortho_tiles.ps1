# build_ortho_tiles.ps1
#
# Build a web basemap tileset from a City of Winnipeg aerial ORTHO year and
# emit a single PMTiles archive for the app's "Aerial <year>" basemap.
#
# Source: the City publishes each year's ortho as a single whole-city ECW
# "Mosaic" (indexed by data.winnipeg.ca dataset sf35-zz6g), on Azure blob
# (wpgopendata.blob.core.windows.net/ortho-photos-<year>/). 2024 = 14 GB ECW,
# 7.5 cm. There is NO web tile service, so we tile it ourselves once per year.
#
# Pipeline (per year):
#   1. resolve the ECW-Mosaic URL from the open-data index (or --Url override)
#   2. download the .ecw.zip (resumable) + unzip the .ecw
#   3. gdalwarp ECW -> EPSG:3857, capped at ~15 cm/px (web zoom 20), into an
#      MBTiles (JPEG tiles); gdaladdo builds the lower-zoom pyramid
#   4. pmtiles convert MBTiles -> wpg-ortho-<year>.pmtiles (~7-10 GB)
#   5. print the Cloudflare R2 upload command (credentials stay with you)
#
# PREREQUISITES (one-time):
#   - OSGeo4W GDAL WITH the ECW plugin:  the base GDAL can't read ECW. Install:
#       C:\OSGeo4W\bin\osgeo4w-setup.exe -q -k -P gdal-ecw
#     Verify:  gdalinfo --formats | findstr /I ECW      (should list "ECW")
#   - go-pmtiles binary (already fetched to ..\..\tools\pmtiles.exe).
#   - ~30 GB free disk during the build (zip + ecw + mbtiles); output ~7-10 GB.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File r\build_ortho_tiles.ps1            # 2024
#   powershell -ExecutionPolicy Bypass -File r\build_ortho_tiles.ps1 -Year 2026
#   ... -TargetResM 0.075   # sharper (~z21, bigger)   |   0.3 = coarser (~z19)

param(
  [int]    $Year        = 2024,
  [string] $Url         = '',                                   # override the auto-resolved mosaic URL
  [double] $TargetResM  = 0.149,                                # 3857 m/px: 0.149 ~= z20, 0.075 ~= z21, 0.3 ~= z19
  [int]    $JpegQuality = 82,
  [string] $WorkDir     = 'D:\WpgOrtho',                        # scratch: OUTSIDE Dropbox + the git repo (build churns ~35 GB of transient files — don't sync them)
  [string] $GdalBin     = 'C:\OSGeo4W\bin',
  [string] $PmtilesExe  = 'D:\Dropbox\ClaudeCode\WpgOpenData\tools\pmtiles.exe',
  [switch] $Force
)
$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

$gdalinfo = Join-Path $GdalBin 'gdalinfo.exe'
$gdalwarp = Join-Path $GdalBin 'gdalwarp.exe'
$gdaladdo = Join-Path $GdalBin 'gdaladdo.exe'
foreach ($exe in @($gdalinfo, $gdalwarp, $gdaladdo, $PmtilesExe)) {
  if (-not (Test-Path $exe)) { throw "missing tool: $exe" }
}

# --- ECW plugin present? (the whole thing needs it) ------------------------
$fmts = & $gdalinfo --formats 2>&1
if (-not ($fmts -match '(?i)\bECW\b')) {
  throw "GDAL has no ECW driver. Install it once:`n" +
        "  C:\OSGeo4W\bin\osgeo4w-setup.exe -q -k -P gdal-ecw`n" +
        "then re-run. (gdalinfo --formats must list ECW.)"
}

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

# --- 1. resolve the ECW Mosaic URL from the open-data index ----------------
Step "Resolve $Year ECW mosaic URL"
if (-not $Url) {
  $q = "https://data.winnipeg.ca/resource/sf35-zz6g.json?" +
       "`$where=year='$Year' AND format='ECW' AND type='Mosaic'&`$limit=1"
  $row = Invoke-RestMethod -Uri $q -TimeoutSec 60
  if (-not $row -or -not $row[0].data_location.url) {
    throw "No ECW Mosaic found for $Year in the open-data index (sf35-zz6g). Pass -Url explicitly."
  }
  $Url = $row[0].data_location.url
  Write-Host "  $($row[0].total_size)  $Url"
}

# --- 2. download (resumable) + unzip ---------------------------------------
Step "Download mosaic"
$zip = Join-Path $WorkDir ("wpg-ortho-$Year.ecw.zip")
if ($Force -or -not (Test-Path $zip)) {
  # curl -C - resumes a partial file; the download is ~14 GB.
  & curl.exe -fL -C - --retry 5 -o $zip $Url
  if ($LASTEXITCODE -ne 0) { throw "download failed ($LASTEXITCODE)" }
} else { Write-Host "  have $zip" }

Step "Unzip ECW"
$ecw = Get-ChildItem -Path $WorkDir -Filter '*.ecw' -File -ErrorAction SilentlyContinue |
       Sort-Object Length -Descending | Select-Object -First 1
if ($Force -or -not $ecw) {
  Expand-Archive -Path $zip -DestinationPath $WorkDir -Force
  $ecw = Get-ChildItem -Path $WorkDir -Filter '*.ecw' -File | Sort-Object Length -Descending | Select-Object -First 1
}
if (-not $ecw) { throw "no .ecw found after unzip" }
Write-Host "  $($ecw.FullName)  ($([math]::Round($ecw.Length/1GB,1)) GB)"

# --- 3. warp ECW -> EPSG:3857 MBTiles (JPEG) + overview pyramid -------------
Step "Warp -> MBTiles (3857, JPEG q$JpegQuality, $TargetResM m/px)"
$mbt = Join-Path $WorkDir ("wpg-ortho-$Year.mbtiles")
if (Test-Path $mbt) { if ($Force) { Remove-Item $mbt -Force } }
if (-not (Test-Path $mbt)) {
  # -tr in 3857 metres caps the base zoom (0.149 ~= z20). -b 1/2/3 drops any
  # alpha so the JPEG tile format is happy. This is the long step (tens of min).
  & $gdalwarp -t_srs EPSG:3857 -tr $TargetResM $TargetResM -r bilinear `
      -b 1 -b 2 -b 3 -of MBTILES `
      -co "TILE_FORMAT=JPEG" -co "QUALITY=$JpegQuality" `
      -multi -wo NUM_THREADS=ALL_CPUS -co "NUM_THREADS=ALL_CPUS" `
      $ecw.FullName $mbt
  if ($LASTEXITCODE -ne 0) { throw "gdalwarp failed ($LASTEXITCODE)" }

  Step "Build overview pyramid (lower zooms)"
  & $gdaladdo -r average $mbt 2 4 8 16 32 64 128 256
  if ($LASTEXITCODE -ne 0) { throw "gdaladdo failed ($LASTEXITCODE)" }
}
Write-Host "  MBTiles: $([math]::Round((Get-Item $mbt).Length/1GB,2)) GB"

# --- 4. MBTiles -> PMTiles -------------------------------------------------
Step "Convert -> PMTiles"
$pm = Join-Path $WorkDir ("wpg-ortho-$Year.pmtiles")
if (Test-Path $pm) { Remove-Item $pm -Force }
& $PmtilesExe convert $mbt $pm
if ($LASTEXITCODE -ne 0) { throw "pmtiles convert failed ($LASTEXITCODE)" }
Write-Host "  PMTiles: $([math]::Round((Get-Item $pm).Length/1GB,2)) GB  -> $pm"
& $PmtilesExe show $pm 2>&1 | Select-String -Pattern 'tile type|min zoom|max zoom|bounds' | ForEach-Object { "    $_" }

# --- 5. upload to Cloudflare R2 (you run this — keeps R2 creds out of here) -
Step "Next: upload to Cloudflare R2"
@"
The tileset is built: $pm

Upload it to your R2 bucket, then point the app at it.

  # one-time: configure rclone for R2 (Account ID + R2 API token, in R2 dashboard)
  rclone config   # new remote 'r2', type=s3, provider=Cloudflare, endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com

  # upload (R2 egress is free):
  rclone copy "$pm" r2:<your-bucket>/ --s3-no-check-bucket --progress

  # enable public access on the bucket (R2 dashboard -> Settings -> Public
  # access, or attach a custom domain), then the public URL is e.g.:
  #   https://<public-r2-domain>/wpg-ortho-$Year.pmtiles

Give me that public URL and I'll set ORTHO_PMTILES_URL in web/src/map.js so the
"Aerial $Year" basemap goes live on the next deploy.
"@ | Write-Host
