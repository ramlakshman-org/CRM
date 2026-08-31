-- ============================================================
-- 040_external_lead_intake.sql
--
-- Prepares wacrm to receive structured leads from an external CRM
-- without taking ownership of that CRM's WhatsApp webhook or message
-- history. External leads become contacts + deals only. A later,
-- separately-approved integration can decide how conversations sync.
-- ============================================================

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS external_source TEXT,
  ADD COLUMN IF NOT EXISTS external_lead_id TEXT,
  ADD COLUMN IF NOT EXISTS sales_intent TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS requested_action TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deals_external_identity_pair_check'
  ) THEN
    ALTER TABLE deals ADD CONSTRAINT deals_external_identity_pair_check
      CHECK (
        (external_source IS NULL AND external_lead_id IS NULL)
        OR
        (external_source IS NOT NULL AND external_lead_id IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deals_external_source_check'
  ) THEN
    ALTER TABLE deals ADD CONSTRAINT deals_external_source_check
      CHECK (
        external_source IS NULL
        OR external_source ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deals_external_lead_id_length_check'
  ) THEN
    ALTER TABLE deals ADD CONSTRAINT deals_external_lead_id_length_check
      CHECK (external_lead_id IS NULL OR char_length(external_lead_id) <= 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deals_sales_intent_check'
  ) THEN
    ALTER TABLE deals ADD CONSTRAINT deals_sales_intent_check
      CHECK (sales_intent IN ('normal', 'high'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'deals_requested_action_length_check'
  ) THEN
    ALTER TABLE deals ADD CONSTRAINT deals_requested_action_length_check
      CHECK (requested_action IS NULL OR char_length(requested_action) <= 120);
  END IF;
END $$;

-- A non-partial unique index still permits any number of manual deals
-- because PostgreSQL treats NULLs as distinct. It gives API retries a
-- database-level backstop without changing existing deal behaviour.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deals_external_identity
  ON deals(account_id, external_source, external_lead_id);

CREATE INDEX IF NOT EXISTS idx_deals_open_sales_intent
  ON deals(account_id, sales_intent, created_at DESC)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS lead_intake_settings (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  pipeline_id UUID REFERENCES pipelines(id) ON DELETE SET NULL,
  stage_id UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  default_assignee_profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE lead_intake_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_intake_settings_select ON lead_intake_settings;
CREATE POLICY lead_intake_settings_select ON lead_intake_settings FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS lead_intake_settings_insert ON lead_intake_settings;
CREATE POLICY lead_intake_settings_insert ON lead_intake_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS lead_intake_settings_update ON lead_intake_settings;
CREATE POLICY lead_intake_settings_update ON lead_intake_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS lead_intake_settings_delete ON lead_intake_settings;
CREATE POLICY lead_intake_settings_delete ON lead_intake_settings FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION validate_lead_intake_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_enabled AND (NEW.pipeline_id IS NULL OR NEW.stage_id IS NULL) THEN
    RAISE EXCEPTION 'Enabled lead intake requires a pipeline and stage';
  END IF;

  IF NEW.pipeline_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pipelines p
    WHERE p.id = NEW.pipeline_id AND p.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'Lead intake pipeline must belong to the account';
  END IF;

  IF NEW.stage_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pipeline_stages ps
    JOIN pipelines p ON p.id = ps.pipeline_id
    WHERE ps.id = NEW.stage_id
      AND p.id = NEW.pipeline_id
      AND p.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'Lead intake stage must belong to the configured pipeline';
  END IF;

  IF NEW.default_assignee_profile_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles pr
    WHERE pr.id = NEW.default_assignee_profile_id
      AND pr.account_id = NEW.account_id
      AND pr.account_role <> 'viewer'
  ) THEN
    RAISE EXCEPTION 'Lead intake assignee must be a non-viewer account member';
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

ALTER FUNCTION validate_lead_intake_settings() OWNER TO postgres;
REVOKE ALL ON FUNCTION validate_lead_intake_settings() FROM PUBLIC;

DROP TRIGGER IF EXISTS validate_lead_intake_settings_trigger ON lead_intake_settings;
CREATE TRIGGER validate_lead_intake_settings_trigger
  BEFORE INSERT OR UPDATE ON lead_intake_settings
  FOR EACH ROW EXECUTE FUNCTION validate_lead_intake_settings();
