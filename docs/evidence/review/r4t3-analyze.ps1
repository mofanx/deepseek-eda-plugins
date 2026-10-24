param([string]$Root = (Get-Location).Path)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Load-Image([string]$path) {
  $bmp = [System.Drawing.Bitmap]::FromFile($path)
  $w = $bmp.Width; $h = $bmp.Height
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $bytes = New-Object byte[] ($stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  $bmp.UnlockBits($data); $bmp.Dispose()
  return @{ w = $w; h = $h; stride = $stride; bytes = $bytes }
}

function Find-VerticalBorder($im) {
  $w = $im.w; $h = $im.h; $stride = $im.stride; $bytes = $im.bytes
  $best = 0; $bestX = -1
  for ($x = 0; $x -lt $w; $x++) {
    $run = 0; $mx = 0
    for ($y = 0; $y -lt $h; $y++) {
      $i = $y * $stride + $x * 4
      if ($bytes[$i + 2] -lt 100 -and $bytes[$i + 1] -lt 100 -and $bytes[$i] -lt 100) { $run++; if ($run -gt $mx) { $mx = $run } } else { $run = 0 }
    }
    if ($mx -gt $best) { $best = $mx; $bestX = $x }
  }
  $cols = @()
  for ($x = 0; $x -lt $w; $x++) {
    $run = 0; $mx = 0
    for ($y = 0; $y -lt $h; $y++) {
      $i = $y * $stride + $x * 4
      if ($bytes[$i + 2] -lt 100 -and $bytes[$i + 1] -lt 100 -and $bytes[$i] -lt 100) { $run++; if ($run -gt $mx) { $mx = $run } } else { $run = 0 }
    }
    if ($mx -ge [Math]::Floor($best * 0.8)) { $cols += $x }
  }
  return @{ center = $bestX; min = ($cols | Measure-Object -Minimum).Minimum; max = ($cols | Measure-Object -Maximum).Maximum; maxRun = $best }
}

function Horizontal-Runs($im, [int]$x) {
  $h = $im.h; $stride = $im.stride; $bytes = $im.bytes
  $runs = @(); $start = -1
  for ($y = 0; $y -lt $h; $y++) {
    $i = $y * $stride + $x * 4
    $dark = ($bytes[$i + 2] -lt 100 -and $bytes[$i + 1] -lt 100 -and $bytes[$i] -lt 100)
    if ($dark -and $start -lt 0) { $start = $y }
    elseif (-not $dark -and $start -ge 0) { $runs += @{ start = $start; end = $y - 1; center = [int](($start + $y - 1) / 2) }; $start = -1 }
  }
  if ($start -ge 0) { $runs += @{ start = $start; end = $h - 1; center = [int](($start + $h - 1) / 2) } }
  return $runs
}

function Analyze($path, [string]$label, [int]$stripX, [bool]$needBorder) {
  $im = Load-Image $path
  $border = $null
  if ($needBorder) { $border = Find-VerticalBorder $im; if ($stripX -lt 0) { $stripX = $border.min - 15 } }
  $hr = Horizontal-Runs $im $stripX
  $centers = @($hr | ForEach-Object { $_.center })
  $diffs = @()
  for ($k = 1; $k -lt $centers.Count; $k++) { $diffs += ($centers[$k] - $centers[$k - 1]) }
  $sd = @($diffs | Sort-Object)
  $pitch = if ($sd.Count -gt 0) { $sd[[int][Math]::Floor($sd.Count / 2)] } else { 0 }
  $scale = if ($pitch -gt 0) { [Math]::Round($pitch / 26.0, 4) } else { 0 }
  # pick the project-name row: the band with the most ink in the left part
  $w = $im.w; $stride = $im.stride; $bytes = $im.bytes
  $lim = if ($null -ne $border) { $border.min - 10 } else { $w }
  $bestCnt = -1; $bandTop = 0; $bandBot = 0
  for ($k = 1; $k -lt $centers.Count; $k++) {
    $t = $centers[$k - 1]; $b = $centers[$k]
    $sp = $b - $t
    if ($sp -lt 0.8 * $pitch -or $sp -gt 1.2 * $pitch) { continue }
    $it = $t + 10; $ib = $b - 10
    if ($ib -le $it) { continue }
    $cnt = 0
    for ($x = 0; $x -lt $lim; $x++) {
      for ($y = $it; $y -le $ib; $y++) {
        $i = $y * $stride + $x * 4
        if ($bytes[$i + 2] -lt 100 -and $bytes[$i + 1] -lt 100 -and $bytes[$i] -lt 100) { $cnt++; break }
      }
    }
    if ($cnt -gt $bestCnt) { $bestCnt = $cnt; $bandTop = $t; $bandBot = $b }
  }
  $innerTop = $bandTop + 10; $innerBot = $bandBot - 10
  $runs = @(); $start = -1
  for ($x = 0; $x -lt $w; $x++) {
    $dark = $false
    for ($y = $innerTop; $y -le $innerBot; $y++) {
      $i = $y * $stride + $x * 4
      if ($bytes[$i + 2] -lt 100 -and $bytes[$i + 1] -lt 100 -and $bytes[$i] -lt 100) { $dark = $true; break }
    }
    if ($dark -and $start -lt 0) { $start = $x }
    elseif (-not $dark -and $start -ge 0) { $runs += @{ start = $start; end = $x - 1 }; $start = -1 }
  }
  if ($start -ge 0) { $runs += @{ start = $start; end = $w - 1 } }
  $out = [ordered]@{
    label = $label; file = $path; width = $w; height = $im.h
    stripX = $stripX; border = $border; pitchPx = $pitch; scalePxPerUnit = $scale
    band = @{ top = $bandTop; bottom = $bandBot; innerTop = $innerTop; innerBot = $innerBot }
    runs = @($runs | ForEach-Object { "$($_.start)-$($_.end)" })
  }
  if ($null -ne $border) {
    $tail = $runs | Where-Object { $_.end -lt $border.min } | Select-Object -Last 1
    $cellRight = if (($border.max - $border.min) -gt 50) { $border.max } else { $null }
    $tu = if ($null -ne $cellRight) {
      $runs | Where-Object { $_.start -gt $border.min -and $_.start -lt $cellRight } | Select-Object -First 1
    } else {
      $runs | Where-Object { $_.start -gt $border.max } | Select-Object -First 1
    }
    $cross = $runs | Where-Object { $_.start -lt $border.min -and $_.end -gt $border.min } | Select-Object -First 1
    $foreign = @()
    if ($tu) { $foreign = @($runs | Where-Object { $_.start -gt $border.min -and $_.end -lt $tu.start }) }
    $out.tailRun = if ($tail) { "$($tail.start)-$($tail.end)" } else { $null }
    $out.tuFuRun = if ($tu) { "$($tu.start)-$($tu.end)" } else { $null }
    $out.foreignRuns = @($foreign | ForEach-Object { "$($_.start)-$($_.end)" })
    if ($cross) {
      $out.mergedWithTuFu = $true
      $out.overflowRun = "$($cross.start)-$($cross.end)"
      $out.tailRun = $null
      $out.tailPage = $null
      $out.foreignInTuFuCell = $false
    } elseif ($tail -and $tu -and $scale -gt 0) {
      $tailPage = [Math]::Round(590.6 - ($tu.start - $tail.end) / $scale, 2)
      $borderPage = [Math]::Round(590.6 - ($tu.start - $border.center) / $scale, 2)
      $out.tailPage = $tailPage
      $out.borderPage = $borderPage
      $out.gapToTuFuUnits = [Math]::Round(($tu.start - $tail.end) / $scale, 2)
      $out.insideDrawnBorderUnits = [Math]::Round($borderPage - $tailPage, 2)
      $out.passes590 = ($tailPage -le 590)
      $out.insideDrawnBorder = ($tailPage -lt $borderPage)
      $out.foreignInTuFuCell = ($foreign.Count -eq 0)
    } else {
      $out.tailPage = $null; $out.mergedWithTuFu = $true
    }
  } else {
    $first = $runs | Select-Object -First 1
    $out.firstRun = if ($first) { "$($first.start)-$($first.end)" } else { $null }
    $out.firstRunStartPx = if ($first) { $first.start } else { $null }
    $out.startPageAssumed = 404.9
  }
  return $out
}

$right = Analyze (Join-Path $Root 'docs/evidence/current/r4t3-d1-after-right.png') 'my-right' -1 $true
$before = Analyze (Join-Path $Root 'docs/evidence/current/r4t1-d1-before-zoom.png') 't2-before' 500 $true
$after = Analyze (Join-Path $Root 'docs/evidence/current/r4t1-d1-after-zoom.png') 't2-after' 500 $true
$left = Analyze (Join-Path $Root 'docs/evidence/current/r4t3-d1-after-left.png') 'my-left' 390 $false

$result = [ordered]@{
  right = $right
  before = $before
  after = $after
  left = $left
  scaleCheck = @{
    t2BeforeScale = $before.scalePxPerUnit
    t2AfterScale = $after.scalePxPerUnit
    sameScale = ([Math]::Abs($before.scalePxPerUnit - $after.scalePxPerUnit) -le 0.2)
    myScale = $right.scalePxPerUnit
    myScaleAtLeastT2 = ($right.scalePxPerUnit -ge $before.scalePxPerUnit)
  }
}
$result | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 (Join-Path $Root 'docs/evidence/current/r4t3-d1-measure.json')
$result | ConvertTo-Json -Depth 10
