# r5t4 (r2t3) - step 1: READ-ONLY pixel measurement of the vertical extents.
#
# The earlier rehearsal only measured x spans (ink along the wire). A vertical-offset plan lives
# or dies on the y extents, so this script measures the bounding box of each ink cluster.
#
# Run from the repo root:
#   pwsh -File docs/evidence/review/r5t4-d2d3-alt-scan.ps1
# Writes <tmp>\r5t4-alt-scan.json. Opens PNG files only; never touches the document.
#
# Frames: 660x2030 px at 8.25 px/unit, x 200-280 (w1) / 355-435 (w2), y 672-918.
# Colour rules are the same as r5t1-d2d3-scan.ps1 so the two measurements are comparable.
#
# Why y-clusters rather than a fixed window: the pin rows are only 10 units apart, so any window
# tall enough to hold one glyph also holds parts of its neighbours, and a window-clipped bbox
# simply reports the window's own edges. This version builds a y-profile and splits it at gaps,
# which is the only way to get a row's true extent.
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
)
Add-Type -AssemblyName System.Drawing

$frames = @{
  w1 = @{ path = Join-Path $RepoRoot 'docs\evidence\current\r2t1-w1-frame.png'; x0 = 200; y0 = 672; scale = 8.25 }
  w2 = @{ path = Join-Path $RepoRoot 'docs\evidence\current\r2t1-w2-frame.png'; x0 = 355; y0 = 672; scale = 8.25 }
}

function Get-Clusters {
  param($Bitmap, [double]$ux1, [double]$ux2, [double]$uy1, [double]$uy2, [string]$kind, [double]$x0, [double]$y0, [double]$scale, [int]$gapPx = 2)
  $px1 = [int][math]::Floor(($ux1 - $x0) * $scale); $px2 = [int][math]::Ceiling(($ux2 - $x0) * $scale)
  $py1 = [int][math]::Floor(($uy1 - $y0) * $scale); $py2 = [int][math]::Ceiling(($uy2 - $y0) * $scale)
  $rows = @{}
  for ($px = [math]::Max(0, $px1); $px -le [math]::Min($Bitmap.Width - 1, $px2); $px++) {
    for ($py = [math]::Max(0, $py1); $py -le [math]::Min($Bitmap.Height - 1, $py2); $py++) {
      $c = $Bitmap.GetPixel($px, $py)
      $hit = $false
      switch ($kind) {
        'black' { if ($c.R -lt 110 -and $c.G -lt 110 -and $c.B -lt 110) { $hit = $true } }
        'blue'  { if ($c.B -gt ($c.R + 40) -and $c.B -gt ($c.G + 40)) { $hit = $true } }
        'green' { if ($c.G -gt ($c.R + 20) -and $c.G -gt ($c.B + 20)) { $hit = $true } }
      }
      if ($hit) {
        if (-not $rows.ContainsKey($py)) { $rows[$py] = @{ minx = $px; maxx = $px; n = 0 } }
        $r = $rows[$py]
        if ($px -lt $r.minx) { $r.minx = $px }
        if ($px -gt $r.maxx) { $r.maxx = $px }
        $r.n++
      }
    }
  }
  if ($rows.Count -eq 0) { return @() }
  $ys = $rows.Keys | Sort-Object
  $clusters = @()
  $cur = @{ y1 = $ys[0]; y2 = $ys[0]; minx = $rows[$ys[0]].minx; maxx = $rows[$ys[0]].maxx; n = $rows[$ys[0]].n }
  for ($i = 1; $i -lt $ys.Count; $i++) {
    $y = $ys[$i]
    if ($y - $cur.y2 -gt $gapPx) {
      $clusters += $cur
      $cur = @{ y1 = $y; y2 = $y; minx = $rows[$y].minx; maxx = $rows[$y].maxx; n = $rows[$y].n }
    } else {
      $cur.y2 = $y
      if ($rows[$y].minx -lt $cur.minx) { $cur.minx = $rows[$y].minx }
      if ($rows[$y].maxx -gt $cur.maxx) { $cur.maxx = $rows[$y].maxx }
      $cur.n += $rows[$y].n
    }
  }
  $clusters += $cur
  return $clusters | ForEach-Object {
    [pscustomobject]@{
      y1 = [math]::Round($y0 + $_.y1 / $scale, 2); y2 = [math]::Round($y0 + $_.y2 / $scale, 2)
      h  = [math]::Round(($_.y2 - $_.y1) / $scale, 2)
      x1 = [math]::Round($x0 + $_.minx / $scale, 2); x2 = [math]::Round($x0 + $_.maxx / $scale, 2)
      pixels = $_.n
    }
  }
}

$specs = @(
  @{ key = 'w1.label'; frame = 'w1'; kind = 'blue';  x1 = 228.5; x2 = 249.5; y1 = 770; y2 = 820 },
  @{ key = 'w1.pin31'; frame = 'w1'; kind = 'black'; x1 = 234.5; x2 = 242.5; y1 = 770; y2 = 820 },
  @{ key = 'w1.pa10';  frame = 'w1'; kind = 'black'; x1 = 252.0; x2 = 269.5; y1 = 770; y2 = 820 },
  @{ key = 'w2.label'; frame = 'w2'; kind = 'blue';  x1 = 368.0; x2 = 391.0; y1 = 770; y2 = 820 },
  @{ key = 'w2.pb10';  frame = 'w2'; kind = 'black'; x1 = 367.5; x2 = 386.5; y1 = 770; y2 = 820 },
  @{ key = 'w2.pin21'; frame = 'w2'; kind = 'black'; x1 = 394.5; x2 = 402.5; y1 = 770; y2 = 820 },
  # full label width, so the vertical corridor is measured against every black glyph the label
  # could land on - not just the one it currently presses
  @{ key = 'w1.blackfull'; frame = 'w1'; kind = 'black'; x1 = 229.33; x2 = 248.48; y1 = 765; y2 = 825 },
  @{ key = 'w2.blackfull'; frame = 'w2'; kind = 'black'; x1 = 369.18; x2 = 388.21; y1 = 765; y2 = 825 }
)

$bitmaps = @{}
foreach ($f in $frames.Keys) { $bitmaps[$f] = [System.Drawing.Bitmap]::FromFile($frames[$f].path) }

$out = @{}
foreach ($s in $specs) {
  $fr = $frames[$s.frame]
  $cs = Get-Clusters -Bitmap $bitmaps[$s.frame] -ux1 $s.x1 -ux2 $s.x2 -uy1 $s.y1 -uy2 $s.y2 -kind $s.kind -x0 $fr.x0 -y0 $fr.y0 -scale $fr.scale
  Write-Output ("=== {0} ({1}) : {2} cluster(s) ===" -f $s.key, $s.kind, $cs.Count)
  foreach ($c in $cs) { Write-Output ("   y {0,7}-{1,7}  h={2,5}  x {3,7}-{4,7}  px={5}" -f $c.y1, $c.y2, $c.h, $c.x1, $c.x2, $c.pixels) }
  $out[$s.key] = $cs
}
foreach ($k in $bitmaps.Keys) { $bitmaps[$k].Dispose() }

$outPath = Join-Path ([System.IO.Path]::GetTempPath()) 'r5t4-alt-scan.json'
$out | ConvertTo-Json -Depth 8 | Set-Content -Path $outPath -Encoding UTF8
Write-Output ("written: " + $outPath)
