-- Migration: link provisioned IoT devices to loads (Issue #10502)
-- POST /api/iot/telemetry/:id previously authorized an iot_device user by
-- comparing req.user.id (the device's profiles.id) against loadId (a
-- load_offers.id) — two unrelated UUID spaces that can never be equal, so
-- provisioned devices always got 403. This adds a real device→load mapping:
-- load_offers.device_id references the provisioning device's profiles.id.
--
-- Provisioning: an admin (service_role) sets load_offers.device_id = <device
-- profile id> when a physical device is assigned to a cold-chain load. The
-- routes then authorize iot_device by comparing load.device_id to req.user.id.

ALTER TABLE load_offers
  ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES profiles(id);

CREATE INDEX IF NOT EXISTS idx_load_offers_device_id
  ON load_offers (device_id);
