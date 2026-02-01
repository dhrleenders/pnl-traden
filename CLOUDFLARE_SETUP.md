Cloudflare Pages setup

Build output directory: site
Functions directory: functions

Secrets:
- KRAKEN_FUTURES_API_KEY
- KRAKEN_FUTURES_API_SECRET

Daily push:
powershell -ExecutionPolicy Bypass -File .\scripts\daily_push_pnl.ps1
