DROP TRIGGER binder_versions_capacity_insert;
DROP TRIGGER binder_versions_capacity_update;

CREATE TRIGGER binder_versions_capacity_insert
BEFORE INSERT ON binder_versions
WHEN NEW.capacity IS NOT NULL AND NEW.capacity < 1
BEGIN
  SELECT RAISE(ABORT, 'binder_capacity_invalid');
END;

CREATE TRIGGER binder_versions_capacity_update
BEFORE UPDATE OF capacity, rows, columns ON binder_versions
WHEN NEW.capacity IS NULL OR NEW.capacity < 1
BEGIN
  SELECT RAISE(ABORT, 'binder_capacity_invalid');
END;
