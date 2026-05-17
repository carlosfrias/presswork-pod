-- Add 'touch_up' to design_packages.status so operators can flag a design
-- for manual editing before approving it into the Listing queue.
--
-- Flow: needs_review → touch_up → (download, edit locally, re-upload)
--       → needs_review → approved
--
-- The touch_up state surfaces a separate section on the Design page showing
-- download links + ReplaceImageForm. Re-uploading a hand-edited PNG sends the
-- design back to needs_review for a final review pass before it reaches Listing.

ALTER TABLE design_packages DROP CONSTRAINT IF EXISTS design_packages_status_check;
ALTER TABLE design_packages ADD CONSTRAINT design_packages_status_check
  CHECK (status IN ('pending','needs_review','touch_up','approved','processing','done','error'));
