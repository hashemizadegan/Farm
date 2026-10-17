DROP TABLE IF EXISTS farm_tasks;
-- Field workers keep read access rather than losing their membership.
UPDATE memberships SET role = 'viewer' WHERE role = 'worker';
UPDATE invitations SET role = 'viewer' WHERE role = 'worker';
DELETE FROM roles WHERE name = 'worker';
