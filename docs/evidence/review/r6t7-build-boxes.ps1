param(
  [string]$Dataset = 'docs/evidence/current/t31-dataset.json',
  [string]$TileManifestPath = 'docs/evidence/current/r8t1-main-hires-tiles.json',
  [string]$Out = 'docs/evidence/current/r6t7-ink-boxes.json'
)
# r6t7: measure the blue ink width of every visible wire-parent Name label from the
# committed r8t1 2.323 px/unit tiles, and combine it with the two 8.25 px/unit
# r2t1 calibration boxes (W1 anchor 210 -> ink x1 229.8; W2 anchor 390 -> ink x1
# 409.8, both +19.8; label y 790.3-794.06 for y=795, i.e. anchor-4.7..anchor-0.94).
# Read-only: reads JSON/PNG, writes only $Out. No bridge/document call.
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$data = Get-Content (Join-Path $root $Dataset) -Raw | ConvertFrom-Json
$tileList = (Get-Content (Join-Path $root $TileManifestPath) -Raw | ConvertFrom-Json).tiles
$wireById = @{}
foreach ($w in $data.wires) { $wireById[$w.PrimitiveId] = $w }

function Is-Blue($c) { return ($c.B -gt 120 -and $c.B -gt $c.R + 40 -and $c.B -gt $c.G + 40) }

$rows = @()
$labels = @($data.attrs | Where-Object {
  $_.Key -eq 'Name' -and -not [string]::IsNullOrWhiteSpace([string]$_.Value) -and
  $null -ne $_.X -and $null -ne $_.Y -and $_.ValueVisible -ne $false -and
  $wireById.ContainsKey($_.ParentPrimitiveId)
})
$cache = @{}
foreach ($a in $labels) {
  $ax = [double]$a.X; $ay = [double]$a.Y; $v = [string]$a.Value; $len = $v.Length
  $x1 = $ax + 19.3
  $y1 = $ay - 4.70
  $y2 = $ay - 0.94
  $fallbackW = [Math]::Max(8.0, 3.18 * $len)
  $box = [ordered]@{
    label = $v; attr = $a.PrimitiveId; ax = $ax; ay = $ay; len = $len
    x1 = $x1; x2 = $x1 + $fallbackW; y1 = $y1; y2 = $y2
    width = $fallbackW; boxQuality = 'model-fallback'; tile = $null; scale = $null
    measured = $false
  }
  # Choose the tile containing the anchor (prefer one that contains the expected box).
  $cand = @($tileList | Where-Object {
    $p = $_.pageRect
    ($ax -ge [double]$p.x1 - 1) -and ($ax -le [double]$p.x2 + 1) -and
    ($ay -ge [double]$p.y1 - 1) -and ($ay -le [double]$p.y2 + 1)
  })
  if ($cand.Count -eq 0) { $rows += [pscustomobject]$box; continue }
  $t = $cand | Sort-Object { [Math]::Abs(([double]$_.pageRect.y2) - $ay) } | Select-Object -First 1
  $p = $t.pageRect; $sc = [double]$t.pxPerUnit
  $key = $t.file
  if (-not $cache.ContainsKey($key)) { $cache[$key] = [System.Drawing.Bitmap]::FromFile((Join-Path $root $t.file)) }
  $bmp = $cache[$key]
  $ix = [int](($ax - [double]$p.x1) * $sc)
  $iy = [int](([double]$p.y2 - $ay) * $sc)
  # Search a strip above/around the anchor, right of it. Widen enough for 8 chars.
  $sx0 = [Math]::Max(0, $ix - [int](2 * $sc))
  $sx1 = [Math]::Min($bmp.Width - 1, $ix + [int]((20 + 4.4 * $len) * $sc))
  $sy0 = [Math]::Max(0, $iy - [int](8 * $sc))
  $sy1 = [Math]::Min($bmp.Height - 1, $iy + [int](1 * $sc))
  $cols = @()
  for ($x = $sx0; $x -le $sx1; $x++) {
    $n = 0; $ymin = $bmp.Height; $ymax = -1
    for ($y = $sy0; $y -le $sy1; $y++) {
      $c = $bmp.GetPixel($x, $y)
      if (Is-Blue $c) { $n++; if ($y -lt $ymin) { $ymin = $y }; if ($y -gt $ymax) { $ymax = $y } }
    }
    $cols += [pscustomobject]@{ x = $x; n = $n; ymin = $ymin; ymax = $ymax }
  }
  $groups = @(); $cur = $null
  foreach ($c in $cols) {
    if ($c.n -gt 0) {
      if ($null -eq $cur -or $c.x -gt $cur.x1 + 2) {
        if ($null -ne $cur) { $groups += $cur }
        $cur = [pscustomobject]@{ x0 = $c.x; x1 = $c.x; n = 0; ymin = $bmp.Height; ymax = -1 }
      }
      $cur.x1 = $c.x; $cur.n += $c.n
      if ($c.ymin -lt $cur.ymin) { $cur.ymin = $c.ymin }
      if ($c.ymax -gt $cur.ymax) { $cur.ymax = $c.ymax }
    }
  }
  if ($null -ne $cur) { $groups += $cur }
  # Prefer a group whose left edge is near the calibrated +19.3 offset.
  $want = $ix + [int](19.3 * $sc)
  $g = $groups | Where-Object { $_.n -ge 4 -and ($_.x1 - $_.x0) -ge 4 } |
       Sort-Object @{ Expression = { [Math]::Abs($_.x0 - $want) } }, @{ Expression = { -($_.x1 - $_.x0) } } |
       Select-Object -First 1
  if ($null -ne $g) {
    $wpx = $g.x1 - $g.x0 + 1
    $wu = $wpx / $sc
    $hpx = $g.ymax - $g.ymin + 1
    $hu = $hpx / $sc
    if ($wu -ge 6 -and $wu -le 34 -and $hu -ge 2.0 -and $hu -le 6.5) {
      $box.width = [Math]::Round($wu, 2)
      $box.boxQuality = 'measured-width-tile'
      $box.tile = $t.tag; $box.scale = $sc; $box.measured = $true
    }
  }
  # The tile's absolute page origin is a requested (not read-back) rect and is
  # registered ~19.3 units right of the label; only its width is used. Placement
  # is the calibrated anchor+19.3 / anchor-4.70..anchor-0.94 from the two 8.25
  # frames. W1/W2 are overridden with their exact 8.25 boxes.
  $box.x1 = $ax + 19.3
  $box.x2 = $box.x1 + $box.width
  $box.y1 = $ay - 4.70
  $box.y2 = $ay - 0.94
  if ($a.PrimitiveId -eq 'attr111') {
    $box.x1 = 229.33; $box.x2 = 248.48; $box.y1 = 790.30; $box.y2 = 794.06
    $box.width = 19.15; $box.boxQuality = 'exact-8.25-w1'; $box.measured = $true
  }
  if ($a.PrimitiveId -eq 'attr102') {
    $box.x1 = 409.80; $box.x2 = 428.90; $box.y1 = 790.30; $box.y2 = 794.06
    $box.width = 19.10; $box.boxQuality = 'exact-8.25-w2-wire'; $box.measured = $true
  }
  $rows += [pscustomobject]$box
}
foreach ($b in $cache.Values) { $b.Dispose() }
$doc = [ordered]@{
  task = 'r6t7 label ink boxes for 55 wire-parent Name labels'
  mode = 'read-only; PNG/JSON reads and this JSON write only'
  dataset = $Dataset
  tiles = $TileManifestPath
  calibration = 'r2t1 8.25 px/unit: W1 attr111 anchor (210,795) ink x1=229.33..248.48 (+19.33); W2 wire label attr102 anchor (390,795) ink x1=409.80..428.90 (+19.80); generic placement +19.3; label y=anchor-4.70..anchor-0.94. Widths are measured from r8t1 2.323 px/unit blue runs (40/55); 15 fallback widths use 3.18*len. The r8t1 tile origin is a requested rect and is registered ~19.3 units right, so only the measured width is used. Boxes are advisory hybrid boxes, not a live bbox.'
  totals = [ordered]@{ labels = $rows.Count; measured = @($rows | Where-Object { $_.measured }).Count; fallback = @($rows | Where-Object { -not $_.measured }).Count }
  labels = $rows
}
$json = $doc | ConvertTo-Json -Depth 8
Set-Content -Encoding utf8 (Join-Path $root $Out) $json
Write-Output ("rows={0} measured={1} fallback={2}" -f $rows.Count, $doc.totals.measured, $doc.totals.fallback)
$rows | Sort-Object ay, ax | Select-Object label, ax, ay, x1, x2, width, y1, y2, boxQuality, tile | Format-Table -AutoSize


