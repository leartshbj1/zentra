DROP TRIGGER IF EXISTS organization_members_seat_insert_guard;
DROP TRIGGER IF EXISTS organization_members_seat_reactivate_guard;
DROP TRIGGER IF EXISTS organization_invitations_seat_insert_guard;
DROP TRIGGER IF EXISTS license_activations_seat_insert_guard;
DROP TRIGGER IF EXISTS license_activations_seat_reactivate_guard;
ALTER TABLE `organizations` DROP COLUMN `seat_limit`;
