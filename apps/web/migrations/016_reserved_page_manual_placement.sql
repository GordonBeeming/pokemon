-- Reservations protect a page from automatic layout, while explicit pocket edits remain valid.
DROP TRIGGER binder_slots_reserved_page_insert;
DROP TRIGGER binder_slots_reserved_page_update;

DROP TRIGGER binder_pages_reserved_update;
CREATE TRIGGER binder_pages_reserved_update
BEFORE UPDATE OF kind ON binder_pages
WHEN NEW.kind = 'reserved' AND OLD.kind <> 'reserved' AND EXISTS (
  SELECT 1 FROM binder_slots slot
  WHERE slot.binder_page_id = NEW.id AND slot.entry_kind <> 'empty'
)
BEGIN
  SELECT RAISE(ABORT, 'binder_reserved_page_not_empty');
END;
