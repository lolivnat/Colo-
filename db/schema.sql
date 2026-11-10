CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('doula', 'gestante')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  city text NOT NULL,
  neighborhood text NOT NULL DEFAULT '',
  about text NOT NULL DEFAULT '',
  services text[] NOT NULL DEFAULT '{}',
  service_mode text NOT NULL DEFAULT '',
  experience_years smallint CHECK (experience_years BETWEEN 0 AND 80),
  price_cents integer CHECK (price_cents >= 0),
  payment_url text,
  published boolean NOT NULL DEFAULT false,
  pregnancy_weeks smallint CHECK (pregnancy_weeks BETWEEN 1 AND 45),
  due_date date,
  preferences text NOT NULL DEFAULT '',
  directory_opt_in boolean NOT NULL DEFAULT false,
  contact_sharing_opt_in boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (payment_url IS NULL OR payment_url ~ '^https://'),
  CHECK (contact_sharing_opt_in = false OR directory_opt_in = true)
);

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS directory_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS contact_sharing_opt_in boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS profiles_public_location_idx
  ON profiles (lower(city), lower(neighborhood))
  WHERE published = true;
CREATE INDEX IF NOT EXISTS profiles_services_idx ON profiles USING gin (services);
CREATE INDEX IF NOT EXISTS profiles_opt_in_directory_idx
  ON profiles (lower(city), lower(neighborhood))
  WHERE directory_opt_in = true AND contact_sharing_opt_in = true;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY,
  gestante_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doula_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (gestante_id <> doula_id),
  UNIQUE (gestante_id, doula_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON messages (conversation_id, created_at, id);

CREATE TABLE IF NOT EXISTS billing_submissions (
  id uuid PRIMARY KEY,
  doula_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'standard',
  amount_cents integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  proof_image bytea,
  proof_mime text CHECK (proof_mime IS NULL OR proof_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewer_id uuid REFERENCES users(id) ON DELETE SET NULL,
  review_note text CHECK (review_note IS NULL OR length(review_note) <= 500),
  access_until timestamptz,
  CHECK (
    (status = 'pending' AND proof_image IS NOT NULL AND proof_mime IS NOT NULL AND reviewed_at IS NULL AND access_until IS NULL)
    OR (status = 'rejected' AND proof_image IS NULL AND proof_mime IS NULL AND reviewed_at IS NOT NULL AND access_until IS NULL)
    OR (status = 'approved' AND proof_image IS NULL AND proof_mime IS NULL AND reviewed_at IS NOT NULL AND access_until IS NOT NULL)
  )
);
ALTER TABLE billing_submissions ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'standard';
ALTER TABLE billing_submissions DROP CONSTRAINT IF EXISTS billing_submissions_amount_cents_check;
ALTER TABLE billing_submissions DROP CONSTRAINT IF EXISTS billing_submission_plan_amount_check;
ALTER TABLE billing_submissions
  ADD CONSTRAINT billing_submission_plan_amount_check
  CHECK ((plan = 'standard' AND amount_cents = 3990) OR (plan = 'premium' AND amount_cents = 5990));
CREATE INDEX IF NOT EXISTS billing_pending_idx
  ON billing_submissions (submitted_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS billing_active_doula_idx
  ON billing_submissions (doula_id, access_until DESC)
  WHERE status = 'approved';
CREATE UNIQUE INDEX IF NOT EXISTS billing_one_pending_per_doula_idx
  ON billing_submissions (doula_id)
  WHERE status = 'pending';
