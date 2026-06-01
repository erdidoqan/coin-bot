-- Grid cycle excursion: alım→satım arası tepe/çukur (max düşüş analizi için).

ALTER TABLE grid_orders ADD COLUMN cycle_entry_price TEXT;
ALTER TABLE grid_orders ADD COLUMN cycle_trough_price TEXT;
ALTER TABLE grid_orders ADD COLUMN cycle_peak_price TEXT;
