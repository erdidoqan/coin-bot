-- Çok borsa fiyat izleme: manuel sembol listesi (kurtarma sembolleri grid_state'ten gelir).
CREATE TABLE spread_monitor_manual (
  symbol TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
