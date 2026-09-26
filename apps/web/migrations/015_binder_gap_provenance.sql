ALTER TABLE binder_slots ADD COLUMN is_manual_gap INTEGER DEFAULT NULL
  CHECK (is_manual_gap IN (0, 1));
