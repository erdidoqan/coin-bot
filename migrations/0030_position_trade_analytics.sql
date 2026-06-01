-- Pozisyon süresince tepe/dip + giriş bağlamı (tick %, WS, gözcü fiyatı)
ALTER TABLE bot_state ADD COLUMN position_entry_context TEXT;
ALTER TABLE bot_state ADD COLUMN position_peak_price TEXT;
ALTER TABLE bot_state ADD COLUMN position_trough_price TEXT;
