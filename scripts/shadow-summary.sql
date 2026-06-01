-- Haftalık shadow / counterfactual özet (D1)
-- Çalıştır: wrangler d1 execute coin-bot-db --remote --file=scripts/shadow-summary.sql

SELECT '=== Son 7 gün: fail_reason kırılımı (30m forward) ===' AS section;

SELECT
  COALESCE(fail_reason, 'unknown') AS fail_reason,
  COUNT(*) AS n,
  ROUND(AVG(CAST(forward_30m_pct AS REAL)), 2) AS avg_forward_30m_pct,
  ROUND(100.0 * SUM(CASE WHEN hit_tp_30m = 1 THEN 1 ELSE 0 END) / COUNT(*), 1) AS hit_tp_30m_pct
FROM micro_shadow_setups
WHERE recorded_at_ms >= (unixepoch('now') - 7 * 86400) * 1000
  AND status = 'complete'
  AND forward_30m_pct IS NOT NULL
GROUP BY fail_reason
ORDER BY n DESC;

SELECT '=== 15m veto (trend_15m_down) ===' AS section;

SELECT
  COUNT(*) AS n,
  ROUND(AVG(CAST(forward_30m_pct AS REAL)), 2) AS avg_forward_30m,
  ROUND(100.0 * SUM(CASE WHEN hit_tp_30m = 1 THEN 1 ELSE 0 END) / COUNT(*), 1) AS hit_tp_pct
FROM micro_shadow_setups
WHERE recorded_at_ms >= (unixepoch('now') - 7 * 86400) * 1000
  AND status = 'complete'
  AND fail_reason = 'trend_15m_down'
  AND forward_30m_pct IS NOT NULL;

SELECT '=== Skor-only geçerdi (15m hariç) ===' AS section;

SELECT
  COUNT(*) AS n,
  ROUND(AVG(CAST(forward_30m_pct AS REAL)), 2) AS avg_forward_30m,
  ROUND(100.0 * SUM(CASE WHEN hit_tp_30m = 1 THEN 1 ELSE 0 END) / COUNT(*), 1) AS hit_tp_pct
FROM micro_shadow_setups
WHERE recorded_at_ms >= (unixepoch('now') - 7 * 86400) * 1000
  AND status = 'complete'
  AND would_pass_score_only = 1
  AND forward_30m_pct IS NOT NULL;

SELECT '=== Bekleyen / tamamlanan ===' AS section;

SELECT status, COUNT(*) AS n
FROM micro_shadow_setups
WHERE recorded_at_ms >= (unixepoch('now') - 7 * 86400) * 1000
GROUP BY status;
