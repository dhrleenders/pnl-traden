# PnL Traden (GitHub + Netlify)

## Wat staat waar?
- `site/` = dit is wat je naar GitHub pusht en wat Netlify publiceert (PWA + `data/pnl.json`)
- `sync/` = dit blijft op je laptop. Hier staan je Kraken keys + sync script.

## Veiligheid
Je API keys gaan **NOOIT** naar GitHub/Netlify. Alleen het gegenereerde `site/data/pnl.json` wordt gecommit.

## Netlify
Koppel in Netlify je GitHub repo.
- Publish directory: `site`
- Build command: leeg

