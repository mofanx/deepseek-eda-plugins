# r5t1 (D2/D3 rehearsal) - step 2 of 3: READ-ONLY pixel scan of the two 8.25 px/unit frames.
#
# Reads docs/evidence/current/r2t1-w1-frame.png and r2t1-w2-frame.png, classifies pixels in a
# horizontal band, prints the contiguous column runs as page units, and writes them to
# <tmp>\r5t1-scan.json for step 3.
#
# Run from the repo root:
#   pwsh -File docs/evidence/review/r5t1-d2d3-scan.ps1
#
# Nothing here touches the document: it only opens PNG files that were already committed.
# The frames are 660x2030 px at 8.25 px/unit, covering x 200-280 (w1) and 355-435 (w2), y 672-918.
#
# Classification (same rules used when the numbers were first measured):
#   black  = all channels < 110        (pin numbers and pin names, drawn in black)
#   green  = G dominant over R and B   (wires)
#   blue   = B dominant over R and G   (net-name labels)
# Two colour rules are needed because a single "dark pixel" rule misses the blue labels entirely.
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
)
Add-Type -AssemblyName System.Drawing

$frames = @(
  @{ name = 'w1'; path = Join-Path $RepoRoot 'docs\evidence\current\r2t1-w1-frame.png'; x0 = 200; y0 = 672; scale = 8.25 },
  @{ name = 'w2'; path = Join-Path $RepoRoot 'docs\evidence\current\r2t1-w2-frame.png'; x0 = 355; y0 = 672; scale = 8.25 }
)

function Get-Runs {
  param($Bitmap, [int]$py0, [int]$py1, [string]$kind, [double]$x0, [double]$scale)
  $cols = New-Object 'System.Collections.Generic.List[int]'
  for ($px = 0; $px -lt $Bitmap.Width; $px++) {
    $hit = $false
    for ($py = $py0; $py -le $py1 -and -not $hit; $py++) {
      $c = $Bitmap.GetPixel($px, $py)
      switch ($kind) {
        'black' { if ($c.R -lt 110 -and $c.G -lt 110 -and $c.B -lt 110) { $hit = $true } }
        'green' { if ($c.G -gt ($c.R + 20) -and $c.G -gt ($c.B + 20)) { $hit = $true } }
        'blue'  { if ($c.B -gt ($c.R + 40) -and $c.B -gt ($c.G + 40)) { $hit = $true } }
      }
    }
    if ($hit) { $cols.Add($px) }
  }
  $runs = @()
  if ($cols.Count -eq 0) { return $runs }
  $start = $cols[0]; $prev = $cols[0]
  foreach ($c in $cols) {
    if ($c - $prev -gt 2) {
      $runs += [pscustomobject]@{ px1 = $start; px2 = $prev; u1 = [math]::Round($x0 + $start / $scale, 2); u2 = [math]::Round($x0 + $prev / $scale, 2) }
      $start = $c
    }
    $prev = $c
  }
  $runs += [pscustomobject]@{ px1 = $start; px2 = $prev; u1 = [math]::Round($x0 + $start / $scale, 2); u2 = [math]::Round($x0 + $prev / $scale, 2) }
  return $runs
}

# The pin row sits at y=795; a 12-unit-tall glyph cluster spans roughly 787.5-797.5.
# Narrower bands (e.g. 785.5-802.5) merge the 785/795/805 rows into one blob - that was a real bug here.
$bandU1 = 787.5; $bandU2 = 797.5

$result = @{}
foreach ($f in $frames) {
  $bmp = [System.Drawing.Bitmap]::FromFile($f.path)
  $py0 = [int](($bandU1 - $f.y0) * $f.scale)
  $py1 = [int](($bandU2 - $f.y0) * $f.scale)
  Write-Output ("=== {0}  {1}x{2} px  band y={3}-{4} unit -> py {5}-{6} ===" -f $f.name, $bmp.Width, $bmp.Height, $bandU1, $bandU2, $py0, $py1)
  $entry = @{}
  foreach ($kind in @('black', 'blue', 'green')) {
    $runs = Get-Runs -Bitmap $bmp -py0 $py0 -py1 $py1 -kind $kind -x0 $f.x0 -scale $f.scale
    $entry[$kind] = $runs
    Write-Output ("  {0,-6} runs={1}" -f $kind, $runs.Count)
    foreach ($r in $runs) { Write-Output ("         px {0,4}-{1,4}  ->  u {2,7}-{3,7}" -f $r.px1, $r.px2, $r.u1, $r.u2) }
  }
  $result[$f.name] = @{ width = $bmp.Width; height = $bmp.Height; band = @($bandU1, $bandU2); runs = $entry }
  $bmp.Dispose()
}

$outPath = Join-Path ([System.IO.Path]::GetTempPath()) 'r5t1-scan.json'
$result | ConvertTo-Json -Depth 8 | Set-Content -Path $outPath -Encoding UTF8
Write-Output ("scan written to {0}" -f $outPath)
