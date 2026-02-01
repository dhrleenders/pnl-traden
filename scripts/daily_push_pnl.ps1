$ErrorActionPreference = "Stop"

$BRANCH = "main"
$REMOTE = "origin"
$RUN_KRAKEN_FUTURES = $true
$RUN_BLOFIN = $false
$PUSH_CSVS = $true

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$ROOT = Resolve-Path (Join-Path $SCRIPT_DIR "..") | Select-Object -ExpandProperty Path
Set-Location $ROOT

Write-Host "Pull latest ($REMOTE/$BRANCH)..." -ForegroundColor Cyan
git -c rebase.autoStash=true pull --rebase $REMOTE $BRANCH

if ($RUN_KRAKEN_FUTURES) {
  if (Test-Path ".\sync\kraken_futures_sync.py") {
    Write-Host "Running Kraken futures sync..." -ForegroundColor Cyan
    Push-Location .\sync
    py .\kraken_futures_sync.py
    Pop-Location
  } else {
    Write-Host "Missing sync\kraken_futures_sync.py" -ForegroundColor Yellow
  }
}

git add .\site\data\pnl.json

if ($PUSH_CSVS) {
  git add .\sync\*.csv 2>$null
}

$changes = git status --porcelain
if (-not $changes) { Write-Host "No changes to commit."; exit 0 }

$stamp = Get-Date -Format "yyyy-MM-dd"
git commit -m "Update pnl data $stamp"
git push $REMOTE $BRANCH

Write-Host "Done ✅" -ForegroundColor Green
