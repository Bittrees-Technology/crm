export const invitesSchema = `
ALTER TABLE invites ADD COLUMN IF NOT EXISTS wallet text;
ALTER TABLE invites ALTER COLUMN email DROP NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='invites_recipient' AND conrelid='invites'::regclass) THEN
  ALTER TABLE invites ADD CONSTRAINT invites_recipient CHECK (
   (email IS NOT NULL AND wallet IS NULL) OR
   (email IS NULL AND wallet IS NOT NULL AND wallet ~ '^0x[0-9a-f]{40}$')
  );
 END IF;
END $$;
`;
