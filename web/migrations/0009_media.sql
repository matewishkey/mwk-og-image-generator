-- Soft delete for reference photos. design_panel.reference_id makes a hard
-- DELETE throw, and the R2 object is content-addressed anyway — so delete is a
-- flag, listings filter on it, and re-uploading the same bytes revives the row.
ALTER TABLE reference ADD COLUMN deleted_at TEXT;
