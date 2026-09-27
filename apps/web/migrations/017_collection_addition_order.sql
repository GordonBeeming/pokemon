ALTER TABLE collection_cards ADD COLUMN last_added_order INTEGER
  CHECK (last_added_order IS NULL OR last_added_order >= 0);

-- Historical updates include note edits, so they cannot establish when a copy was added.
UPDATE collection_cards SET last_added_order = 0;
CREATE INDEX collection_owner_addition_order ON collection_cards(owner_id,last_added_order);

CREATE TRIGGER collection_addition_insert AFTER INSERT ON collection_cards
WHEN NEW.quantity > 0 AND NEW.last_added_order IS NULL
BEGIN
  UPDATE collection_cards
  SET last_added_order = (
    SELECT COALESCE(MAX(last_added_order),0)+1 FROM collection_cards WHERE owner_id=NEW.owner_id
  )
  WHERE owner_id=NEW.owner_id AND card_id=NEW.card_id;
END;

CREATE TRIGGER collection_addition_update AFTER UPDATE OF quantity ON collection_cards
WHEN NEW.quantity > OLD.quantity
BEGIN
  UPDATE collection_cards
  SET last_added_order = (
    SELECT COALESCE(MAX(last_added_order),0)+1 FROM collection_cards WHERE owner_id=NEW.owner_id
  )
  WHERE owner_id=NEW.owner_id AND card_id=NEW.card_id;
END;
