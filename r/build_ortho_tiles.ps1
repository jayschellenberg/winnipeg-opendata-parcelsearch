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
# PREREQUISITES:
#   - OSGeo4W GDAL with the ECW plugin (gdal_ECW_JP2ECW.dll under
#     apps\gdal\lib\gdalplugins) - usually ALREADY present with OSGeo4W. This
#     script sources C:\OSGeo4W\bin\o4w_env.bat itself (sets GDAL_DATA / PROJ_LIB
#     / the plugin path), so a plain PowerShell run works - no OSGeo4W shell
#     needed. If the ECW check below still fails, add the plugin once:
#       C:\OSGeo4W\bin\osgeo4w-setup.exe -q -k -P gdal-ecw
#   - go-pmtiles binary (already fetched to ..\..\tools\pmtiles.exe).
#   - ~40 GB free disk during the build (zip + ecw + mbtiles); output ~7-10 GB.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File r\build_ortho_tiles.ps1            # 2024
#   powershell -ExecutionPolicy Bypass -File r\build_ortho_tiles.ps1 -Year 2026
#   ... -TargetResM 0.075   # sharper (~z21, bigger)   |   0.3 = coarser (~z19)

param(
  [int]    $Year        = 2024,
  [string] $Url         = '',                                   # override the auto-resolved mosaic URL
  [string] $SourceSrs   = '',                                   # assign source SRS when the ECW lacks one (2021: EPSG:26914 = UTM 14N)
  [double] $TargetResM  = 0.149,                                # 3857 m/px: 0.149 ~= z20, 0.075 ~= z21, 0.3 ~= z19
  [int]    $JpegQuality = 82,
  [string] $WorkDir     = 'D:\WpgOrtho',                        # scratch: OUTSIDE Dropbox + the git repo (build churns ~35 GB of transient files - don't sync them)
  [string] $GdalBin     = 'C:\OSGeo4W\bin',
  [string] $PmtilesExe  = 'D:\Dropbox\ClaudeCode\WpgOpenData\tools\pmtiles.exe',
  [switch] $Force
)
$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

$gdalinfo = Join-Path $GdalBin 'gdalinfo.exe'
$gdalwarp = Join-Path $GdalBin 'gdalwarp.exe'
$gdaladdo = Join-Path $GdalBin 'gdaladdo.exe'
$gdalbuildvrt = Join-Path $GdalBin 'gdalbuildvrt.exe'
$gdalsrsinfo = Join-Path $GdalBin 'gdalsrsinfo.exe'
foreach ($exe in @($gdalinfo, $gdalwarp, $gdaladdo, $gdalbuildvrt, $gdalsrsinfo, $PmtilesExe)) {
  if (-not (Test-Path $exe)) { throw "missing tool: $exe" }
}

# --- Load the OSGeo4W environment ------------------------------------------
# The OSGeo4W GDAL exes need GDAL_DATA / PROJ_LIB and - crucially - the
# gdal-plugins path on GDAL_DRIVER_PATH, or the ECW driver silently doesn't
# load (and you get "GDAL_DATA is not defined" warnings). o4w_env.bat sets all
# of it; import its vars into this session so a plain PowerShell run works.
$o4w = Join-Path $GdalBin 'o4w_env.bat'
if (Test-Path $o4w) {
  cmd /c "`"$o4w`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$' -and $matches[1] -notmatch '^[=(]') {
      try { Set-Item -Path "Env:\$($matches[1])" -Value $matches[2] -ErrorAction Stop } catch {}
    }
  }
} else {
  Write-Warning "OSGeo4W env script not found at $o4w - GDAL may miss its data / the ECW plugin."
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
# Delivery format varies by year: a raw .ecw (2021: MBCWPG21_Property_Delivery.ecw,
# 16 GB), a .zip holding one whole-city ECW (2024), or a .zip of many ECW tiles
# (2026: 15). Pick the local name + whether to unzip from the URL extension.
$isZip = $Url -match '\.zip($|\?)'
Step "Download mosaic"
$dl = Join-Path $WorkDir ("wpg-ortho-$Year" + $(if ($isZip) { '.ecw.zip' } else { '.ecw' }))
if ($Force -or -not (Test-Path $dl)) {
  # curl -C - resumes a partial file.
  & curl.exe -fL -C - --retry 5 -o $dl $Url
  if ($LASTEXITCODE -ne 0) { throw "download failed ($LASTEXITCODE)" }
} else { Write-Host "  have $dl" }

Step "Unpack ECW"
$ecws = Get-ChildItem -Path $WorkDir -Filter '*.ecw' -File -ErrorAction SilentlyContinue
if ($isZip) {
  if ($Force -or -not $ecws) {
    Expand-Archive -Path $dl -DestinationPath $WorkDir -Force
    $ecws = Get-ChildItem -Path $WorkDir -Filter '*.ecw' -File
  }
} else {
  # raw .ecw download IS the mosaic (saved as wpg-ortho-<year>.ecw)
  $ecws = Get-ChildItem -Path $WorkDir -Filter '*.ecw' -File
}
if (-not $ecws) { throw "no .ecw found after download/unpack" }

# The City's "Mosaic" is a SINGLE whole-city ECW some years (2024:
# MBCWPG24_Property.ecw, 14 GB) but a SET of large corner-named ECW tiles others
# (2026: 15 tiles, ~102 GB total). More than one -> virtually mosaic them with a
# VRT so the warp covers the WHOLE city; else we'd tile only the largest piece.
if ($ecws.Count -eq 1) {
  $warpInput = $ecws[0].FullName
  Write-Host "  single ECW: $warpInput  ($([math]::Round($ecws[0].Length/1GB,1)) GB)"
} else {
  $vrt = Join-Path $WorkDir ("wpg-ortho-$Year.vrt")
  $tot = [math]::Round((($ecws | Measure-Object Length -Sum).Sum)/1GB,1)
  Write-Host "  $($ecws.Count) ECW tiles ($tot GB) -> VRT mosaic $vrt"
  $tilePaths = @($ecws | ForEach-Object { $_.FullName })
  & $gdalbuildvrt -overwrite $vrt @tilePaths
  if ($LASTEXITCODE -ne 0) { throw "gdalbuildvrt failed ($LASTEXITCODE)" }
  $warpInput = $vrt
}

# --- 3. warp ECW -> EPSG:3857 MBTiles (JPEG) + overview pyramid -------------
Step "Warp -> MBTiles (3857, JPEG q$JpegQuality, $TargetResM m/px)"
$mbt = Join-Path $WorkDir ("wpg-ortho-$Year.mbtiles")
if (Test-Path $mbt) { if ($Force) { Remove-Item $mbt -Force } }
if (-not (Test-Path $mbt)) {
  # The MBTiles driver only accepts a base resolution that is EXACTLY a
  # web-mercator zoom level, else it dies with "Could not find an appropriate
  # zoom level that matches raster pixel size". Snap the requested $TargetResM
  # to the nearest zoom's exact 3857 m/px, and -tap so the output pixel grid
  # aligns to the global tile grid (whose origin is an integer multiple of the
  # zoom resolution). -b 1/2/3 drops alpha so the JPEG tile format is happy.
  # This is the long step (tens of min).
  $res0    = 2 * [math]::PI * 6378137 / 256                      # zoom-0 m/px (EPSG:3857)
  $zoom    = [int][math]::Round([math]::Log($res0 / $TargetResM, 2))
  $snapRes = $res0 / [math]::Pow(2, $zoom)
  Write-Host "  base zoom z$zoom  ($([math]::Round($snapRes,6)) m/px, snapped from $TargetResM)"
  # Some ECW mosaics ship WITHOUT an embedded SRS (2021's raw .ecw). Then gdalwarp
  # treats the source pixel coords as if already EPSG:3857 -> tiles land at the
  # wrong place + scale. If -SourceSrs is given, assign it (-s_srs); otherwise
  # verify the source HAS an SRS and fail loudly if not.
  $srcArgs = @()
  if ($SourceSrs) {
    $srcArgs = @('-s_srs', $SourceSrs)
    Write-Host "  assigning source SRS: $SourceSrs"
  } else {
    & $gdalsrsinfo -o epsg $warpInput *> $null
    if ($LASTEXITCODE -ne 0) {
      throw "source $warpInput has NO embedded SRS. Re-run with -SourceSrs (City of Winnipeg ortho is UTM zone 14N = EPSG:26914)."
    }
  }
  & $gdalwarp -t_srs EPSG:3857 @srcArgs -tr $snapRes $snapRes -tap -r bilinear `
      -b 1 -b 2 -b 3 -of MBTILES `
      -co "TILE_FORMAT=JPEG" -co "QUALITY=$JpegQuality" `
      -multi -wo NUM_THREADS=ALL_CPUS `
      $warpInput $mbt
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

# --- 5. upload to Cloudflare R2 (you run this - keeps R2 creds out of here) -
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
