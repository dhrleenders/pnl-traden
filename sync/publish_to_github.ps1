$ErrorActionPreference = "Stop"

# ---- Paths (edit if you moved the folder) ----
$RepoRoot = "C:\pnl-traden"          # <-- this folder (repo root)
$SyncDir  = Join-Path $RepoRoot "sync"
$SiteDir  = Join-Path $RepoRoot "site"

# 1) Run sync (generates site\data\pnl.json)
Set-Location $SyncDir
py -m pip install -r requirements.txt | Out-Null
py .\kraken_futures_sync.py

# 2) Commit + push ONLY if changed
Set-Location $RepoRoot
git add site\data\pnl.json

$diff = git status --porcelain
if ($diff) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  git commit -m "Update pnl.json ($ts)"
  git push
  Write-Host "Pushed update to GitHub."
} else {
  Write-Host "No changes in pnl.json (nothing to push)."
}
