# r6t3 - READ-ONLY pixel re-measurement for the t2 review.
#
# Two things are checked here:
#   1. r5t7's claimed gaps (2.07 above, 1.94 below) and its 4.85 pin-number clusters.
#   2. r6t2's normal-label ink boxes. The proposal lists [229.33,248.48,780.12,783.88] for the
#      row-785 labels; that is the BLACK band, while a net-name label is BLUE. If the blue box is
#      780.30-784.06, every margin in the proposal is computed on the wrong rectangle and the
#      1.0 threshold was calibrated on it.
#
# Opens PNG files only. Writes <tmp>\r6t3-ink-check.json. Never touches the document.
#
# Run from the repo root:
#   pwsh -File docs/evidence/review/r6t3-ink-check.ps1
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
        'dark'  { if ($c.R -lt 190 -and $c.G -lt 190 -and $c.B -lt 190) { $hit = $true } }
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
  # 1. the pressed pair, both colours, so the blue label box and the black glyph box are separate
  @{ key = 'w1.blue_left';    frame = 'w1'; kind = 'blue';  x1 = 228.5; x2 = 249.5; y1 = 772; y2 = 802 },
  @{ key = 'w1.black_left';   frame = 'w1'; kind = 'black'; x1 = 229.33; x2 = 248.48; y1 = 772; y2 = 802 },
  @{ key = 'w1.pin31';        frame = 'w1'; kind = 'black'; x1 = 232.0; x2 = 244.0; y1 = 770; y2 = 822 },
  # 2. the w2 side: blue label box vs black glyph band, same rows
  @{ key = 'w2.blue_right';   frame = 'w2'; kind = 'blue';  x1 = 368.0; x2 = 391.0; y1 = 772; y2 = 822 },
  @{ key = 'w2.black_right';  frame = 'w2'; kind = 'black'; x1 = 369.18; x2 = 388.21; y1 = 772; y2 = 822 },
  @{ key = 'w2.pb10';         frame = 'w2'; kind = 'black'; x1 = 367.5; x2 = 386.5; y1 = 785; y2 = 800 },
  # 3. MCU-33's own label at row 785, left side: blue, own wire y=785
  @{ key = 'w1.blue_row785';  frame = 'w1'; kind = 'blue';  x1 = 229.33; x2 = 248.48; y1 = 774; y2 = 790 },
  # 4. green wires, to confirm which rows actually carry a wire in these frames
  @{ key = 'w1.green';        frame = 'w1'; kind = 'green'; x1 = 200; x2 = 280; y1 = 772; y2 = 802 },
  @{ key = 'w2.green';        frame = 'w2'; kind = 'green'; x1 = 355; x2 = 435; y1 = 772; y2 = 822 },
  # 5. who owns the 790.30-794.67 black band? "31" sits at x=224 and PA10 at x=233, so scan the
  #    two columns separately instead of the whole label corridor.
  @{ key = 'w1.num31_col';    frame = 'w1'; kind = 'black'; x1 = 218.0; x2 = 229.2; y1 = 782; y2 = 800 },
  @{ key = 'w1.pa10_col';     frame = 'w1'; kind = 'black'; x1 = 233.0; x2 = 247.0; y1 = 783; y2 = 792 },
  @{ key = 'w1.corridor_blk'; frame = 'w1'; kind = 'black'; x1 = 229.33; x2 = 248.48; y1 = 789; y2 = 796 },
  # 6. "31" may be drawn in a lighter grey than the threshold above accepts; scan its own column
  #    with a loose threshold, and the same column for reference with the strict one.
  @{ key = 'w1.num31_loose';  frame = 'w1'; kind = 'dark';  x1 = 212.0; x2 = 232.0; y1 = 786; y2 = 800 },
  @{ key = 'w1.full_loose';   frame = 'w1'; kind = 'dark';  x1 = 212.0; x2 = 252.0; y1 = 786; y2 = 800 }
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

$outPath = Join-Path ([System.IO.Path]::GetTempPath()) 'r6t3-ink-check.json'
$out | ConvertTo-Json -Depth 8 | Set-Content -Path $outPath -Encoding UTF8
Write-Output ("written: " + $outPath)
