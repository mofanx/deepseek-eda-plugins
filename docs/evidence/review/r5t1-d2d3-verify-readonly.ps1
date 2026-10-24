# r5t1 (D2/D3 rehearsal) - the read-only gate.
#
# The three rehearsal scripts are supposed to be read-only. This gate proves it mechanically
# instead of taking the header comment's word for it: it scans only the three step files
# (never itself), so the method names appearing below cannot pollute the result.
#
# Run from the repo root:
#   pwsh -File docs/evidence/review/r5t1-d2d3-verify-readonly.ps1
# Exit 0 + "PASS" means: no document-mutating call is reachable from the rehearsal scripts.
# Exit 1 + the matching lines means: something in there can write, and the claim is void.
#
# Two deliberate choices:
#   * each verb is matched separately - an alternation built with -join would depend on the
#     caller's quoting, and a mangled pattern fails OPEN (silently matching nothing). That
#     exact bug made an earlier version of this gate vacuously PASS.
#   * the verb list is assembled from fragments, so this file does not match itself if a future
#     gate widens the scan to the whole directory.

# Passing -Extra with a file that DOES contain a mutating call is the negative control:
#   pwsh -File docs/evidence/review/r5t1-d2d3-verify-readonly.ps1 -Extra <a file with .save()>
# must print FAIL and exit 1. A gate that cannot fail proves nothing, so this is part of the
# evidence, not an optional nicety.
param(
  [string]$Extra
)

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$targets = @(
  (Join-Path $repo 'docs\evidence\review\r5t1-d2d3-dump.mjs'),
  (Join-Path $repo 'docs\evidence\review\r5t1-d2d3-scan.ps1'),
  (Join-Path $repo 'docs\evidence\review\r5t1-d2d3-verdict.mjs')
)
if ($Extra) { $targets += (Resolve-Path $Extra).Path }
# NOTE on precedence: in PowerShell the comma operator binds tighter than +, so
# @('sa' + 've', 'mod' + 'ify') would parse as 'sa' + ('ve','mod') + 'ify' and silently build
# a space-containing pattern that never matches. Each element is parenthesised for that reason.
$verbs = @(('sa' + 've'), ('mod' + 'ify'), ('cre' + 'ate'), ('del' + 'ete'), ('cle' + 'ar'))

Write-Output ("scanned {0} files for document-mutating calls" -f $targets.Count)
$hits = @()
foreach ($t in $targets) {
  if (-not (Test-Path $t)) { Write-Output ("MISSING  " + $t); $hits += $t; continue }
  foreach ($v in $verbs) {
    # a CALL, not a mention: dot, the verb, optional spaces, then an opening paren
    $m = Select-String -Path $t -Pattern ('(?i)\.\s*' + $v + '\s*\(')
    if ($m) { $hits += $m }
  }
}

if ($hits.Count -eq 0) {
  Write-Output 'PASS - 0 mutating document calls; the rehearsal scripts only read'
  exit 0
}
Write-Output 'FAIL - a mutating call is reachable:'
$hits | ForEach-Object { Write-Output ('  ' + $_.Path + ':' + $_.LineNumber + ': ' + $_.Line.Trim()) }
exit 1
