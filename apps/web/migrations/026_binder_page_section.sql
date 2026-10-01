-- What each binder page's header names on its right: the section the page sits in,
-- taken from the nearest reserved page before it, the nearest bookmark of any kind,
-- or nothing. Per binder, like peek and frame; existing binders keep showing the
-- reserved-page section.
ALTER TABLE binders ADD COLUMN page_section TEXT NOT NULL DEFAULT 'reserved'
  CHECK (page_section IN ('reserved', 'bookmark', 'none'));
