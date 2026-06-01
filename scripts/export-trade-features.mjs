#!/usr/bin/env node
/**
 * Faz 5: trade_features export (offline clustering için).
 * Kullanım: wrangler d1 execute coin-bot-db --remote --command "SELECT ..."
 * veya local: npm run db:export:features (aşağıdaki SQL'i wrangler ile çalıştırın)
 */
console.log(`
Export SQL (remote):

  wrangler d1 execute coin-bot-db --remote --command \\
    "SELECT id, symbol, phase, entry_mode, outcome, pnl, regime, features, created_at FROM trade_features ORDER BY id"

CSV için admin API veya D1 dashboard kullanın.
Offline clustering: başarılı outcome IN ('tp') ve pnl > 0 satırları filtreleyin.
`);
