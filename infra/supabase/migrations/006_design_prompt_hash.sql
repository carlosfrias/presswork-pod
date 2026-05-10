ALTER TABLE design_packages ADD COLUMN fal_prompt_hash TEXT;
CREATE INDEX idx_design_packages_fal_prompt_hash ON design_packages(fal_prompt_hash);
