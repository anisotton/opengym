-- openGym v1.4.3 recovery codes (#584): a recovery code is a device link made by someone else
-- (an admin from the dashboard, or the server's own command, recover.js) for a person who has lost
-- every way in. It lives a day instead of ten minutes and says who made it. Purely additive:
-- every existing row is an ordinary device link (`kind` NULL), exactly as before.
ALTER TABLE device_links ADD COLUMN kind text CHECK (kind IN ('recovery'));
-- An admin's user id, or 'server' for recover.js. Text with no foreign key, like invites.used_by:
-- the record of who made it should not vanish with the admin's account.
ALTER TABLE device_links ADD COLUMN created_by text;
