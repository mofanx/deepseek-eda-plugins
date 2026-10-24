param([string]$Png, [string]$Out)
Add-Type -AssemblyName System.Drawing
$b = [System.Drawing.Bitmap]::FromFile($Png)
$W = $b.Width; $H = $b.Height
$rows = New-Object System.Collections.Generic.List[object]
for ($y = 0; $y -lt $H; $y++) {
  $nb = 0; $nu = 0; $ng = 0
  $bx0 = $W; $bx1 = -1; $ux0 = $W; $ux1 = -1
  for ($x = 0; $x -lt $W; $x++) {
    $c = $b.GetPixel($x, $y)
    if ($c.R -lt 110 -and $c.G -lt 110 -and $c.B -lt 110) {
      $nb++; if ($x -lt $bx0) { $bx0 = $x }; if ($x -gt $bx1) { $bx1 = $x }
    } elseif ($c.B -gt $c.R + 40 -and $c.B -gt $c.G + 40) {
      $nu++; if ($x -lt $ux0) { $ux0 = $x }; if ($x -gt $ux1) { $ux1 = $x }
    } elseif ($c.G -gt $c.R + 20 -and $c.G -gt $c.B + 20) {
      $ng++
    }
  }
  if ($nb -gt 0 -or $nu -gt 0 -or $ng -gt 0) {
    $rows.Add([pscustomobject]@{ y=$y; black=$nb; blue=$nu; green=$ng; blackX0=$bx0; blackX1=$bx1; blueX0=$ux0; blueX1=$ux1 })
  }
}
$b.Dispose()

function Group-Rows($items, $key, $gap) {
  $out = New-Object System.Collections.Generic.List[object]
  $cur = $null
  foreach ($r in $items) {
    if ($null -eq $cur -or $r.y -gt $cur.y1 + $gap) {
      if ($null -ne $cur) { $out.Add($cur) }
      $cur = [pscustomobject]@{ y0=$r.y; y1=$r.y; count=0; x0=99999; x1=-1 }
    }
    $cur.y1 = $r.y
    $cur.count += $r.$key
    if ($r.blackX0 -lt $cur.x0 -and $key -eq 'black') { $cur.x0=$r.blackX0 }
    if ($r.blackX1 -gt $cur.x1 -and $key -eq 'black') { $cur.x1=$r.blackX1 }
    if ($r.blueX0 -lt $cur.x0 -and $key -eq 'blue') { $cur.x0=$r.blueX0 }
    if ($r.blueX1 -gt $cur.x1 -and $key -eq 'blue') { $cur.x1=$r.blueX1 }
  }
  if ($null -ne $cur) { $out.Add($cur) }
  return $out
}
$blueRows = @($rows | Where-Object { $_.blue -gt 0 })
$blackRows = @($rows | Where-Object { $_.black -gt 0 })
$greenRows = @($rows | Where-Object { $_.green -gt 0 })
$blue = Group-Rows $blueRows 'blue' 2
$black = Group-Rows $blackRows 'black' 2
$green = Group-Rows $greenRows 'green' 2
$result = [pscustomobject]@{
  image = @{ w=$W; h=$H }
  blueBands = $blue
  blackBands = $black
  greenBands = $green
}
$json = $result | ConvertTo-Json -Depth 5 -Compress
[System.IO.File]::WriteAllText($Out, $json, [System.Text.UTF8Encoding]::new($false))
Write-Output "wrote $Out"
