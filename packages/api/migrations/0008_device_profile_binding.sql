-- 0008_device_profile_binding.sql — A4 AdapterRegistry seam (plan §6.3/A4,
-- PRD §39–40): a registered device references the DeviceProfile that drives
-- canonicalization of its ASTM stream. Deleting a profile detaches devices
-- (they fall back to the generic reference layout) rather than deleting them.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS profile_id text REFERENCES device_profiles (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_devices_profile ON devices (profile_id);
