-- Y12 (real-yield plan §7.3, D-29): the explicit link between a login (users) and an RWA party.
-- Explicit (an operator proposes it for a named party and user), consented (the linked user accepts a recorded
-- consent text, by its version and SHA-256), authorised (a second operator, neither the proposer nor the user,
-- authorises it), revocable (the user or an operator, at any time; terminal) and audited (an append-only event log;
-- who-did-what also goes to audit_events).
--
-- A link never creates or derives a party: the party must already exist in the same workspace, and nothing here
-- inserts parties. parties.user_id (0012) is not a link and is never read for holder access.
-- Holder-facing endpoints (Y13) read only active links. The consent wording is not legally approved (D-39): the
-- version recorded is whatever the service offered, and the service is off by default and refused in production.

CREATE TABLE party_account_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  party_id            uuid NOT NULL,
  user_id             uuid NOT NULL REFERENCES users(id),
  status              text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'consented', 'active', 'revoked')),
  proposed_by         uuid NOT NULL REFERENCES users(id),
  proposed_at         timestamptz NOT NULL DEFAULT now(),
  consent_version     text CHECK (consent_version ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'),
  consent_sha256      text CHECK (consent_sha256 ~ '^[0-9a-f]{64}$'),
  consented_at        timestamptz,
  authorised_by       uuid REFERENCES users(id),
  authorised_at       timestamptz,
  revoked_by          uuid REFERENCES users(id),
  revoked_at          timestamptz,
  revocation_reason   text CHECK (length(revocation_reason) BETWEEN 1 AND 2000),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id) ON DELETE RESTRICT,
  -- The user is never their own proposer or authoriser; the authoriser is not the proposer (four-eyes).
  CONSTRAINT party_account_links_not_self_proposed CHECK (proposed_by <> user_id),
  CONSTRAINT party_account_links_four_eyes CHECK (authorised_by IS NULL OR (authorised_by <> proposed_by AND authorised_by <> user_id)),
  CHECK ((consented_at IS NULL) = (consent_sha256 IS NULL) AND (consent_sha256 IS NULL) = (consent_version IS NULL)),
  CHECK ((authorised_at IS NULL) = (authorised_by IS NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (status <> 'revoked')),
  CHECK (status NOT IN ('consented', 'active') OR consented_at IS NOT NULL),
  CHECK (status <> 'active' OR authorised_at IS NOT NULL)
);
-- One live (not revoked) link per party and per user in a workspace.
CREATE UNIQUE INDEX party_account_links_party_live_idx ON party_account_links (tenant_id, party_id) WHERE status <> 'revoked';
CREATE UNIQUE INDEX party_account_links_user_live_idx ON party_account_links (tenant_id, user_id) WHERE status <> 'revoked';
CREATE INDEX party_account_links_user_idx ON party_account_links (user_id);

CREATE TABLE party_account_link_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  link_id     uuid NOT NULL,
  event       text NOT NULL CHECK (event IN ('proposed', 'consented', 'authorised', 'revoked')),
  actor_id    uuid NOT NULL REFERENCES users(id),
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, link_id) REFERENCES party_account_links(tenant_id, id)
);
CREATE INDEX party_account_link_events_link_idx ON party_account_link_events (tenant_id, link_id, id);
CREATE TRIGGER party_account_link_events_append_only BEFORE UPDATE OR DELETE ON party_account_link_events
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- proposed → consented (by the user) → active (authorised) ; any live state → revoked (terminal). The identity of a
-- link and each recorded step never change. Every step is logged by this trigger (SECURITY DEFINER: the
-- application role cannot write the log directly).
CREATE FUNCTION party_account_links_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ev text; actor uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'party account links are never deleted (revoke instead)' USING ERRCODE = 'insufficient_privilege', HINT = 'link:immutable';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' OR NEW.consented_at IS NOT NULL OR NEW.authorised_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'a link starts as proposed' USING ERRCODE = 'check_violation', HINT = 'link:invalid_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.party_id, NEW.user_id, NEW.proposed_by, NEW.proposed_at) IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.party_id, OLD.user_id, OLD.proposed_by, OLD.proposed_at)
     OR (OLD.consented_at IS NOT NULL AND (NEW.consented_at, NEW.consent_sha256, NEW.consent_version) IS DISTINCT FROM (OLD.consented_at, OLD.consent_sha256, OLD.consent_version))
     OR (OLD.authorised_at IS NOT NULL AND (NEW.authorised_at, NEW.authorised_by) IS DISTINCT FROM (OLD.authorised_at, OLD.authorised_by)) THEN
    RAISE EXCEPTION 'a link''s identity and recorded steps never change' USING ERRCODE = 'check_violation', HINT = 'link:immutable';
  END IF;
  IF NEW.status = OLD.status THEN
    RAISE EXCEPTION 'a link changes only by a step' USING ERRCODE = 'check_violation', HINT = 'link:invalid_transition';
  END IF;
  IF OLD.status = 'proposed' AND NEW.status = 'consented' THEN ev := 'consented'; actor := NEW.user_id;
  ELSIF OLD.status = 'consented' AND NEW.status = 'active' THEN ev := 'authorised'; actor := NEW.authorised_by;
  ELSIF OLD.status IN ('proposed', 'consented', 'active') AND NEW.status = 'revoked' THEN ev := 'revoked'; actor := NEW.revoked_by;
  ELSE
    RAISE EXCEPTION 'a link cannot go from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation', HINT = 'link:invalid_transition';
  END IF;
  INSERT INTO party_account_link_events (tenant_id, link_id, event, actor_id, detail)
    VALUES (NEW.tenant_id, NEW.id, ev, actor, CASE ev WHEN 'consented' THEN jsonb_build_object('consentVersion', NEW.consent_version, 'consentSha256', NEW.consent_sha256)
                                                      WHEN 'revoked' THEN jsonb_build_object('reason', NEW.revocation_reason) ELSE '{}'::jsonb END);
  RETURN NEW;
END $$;
CREATE TRIGGER party_account_links_guard BEFORE INSERT OR UPDATE OR DELETE ON party_account_links
  FOR EACH ROW EXECUTE FUNCTION party_account_links_guard();

CREATE FUNCTION party_account_links_proposed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO party_account_link_events (tenant_id, link_id, event, actor_id) VALUES (NEW.tenant_id, NEW.id, 'proposed', NEW.proposed_by);
  RETURN NULL;
END $$;
CREATE TRIGGER party_account_links_proposed AFTER INSERT ON party_account_links
  FOR EACH ROW EXECUTE FUNCTION party_account_links_proposed();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['party_account_links', 'party_account_link_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I TO metafarm_app USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    EXECUTE format('CREATE POLICY owner_bypass ON %I TO CURRENT_USER USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON party_account_links TO metafarm_app;
GRANT SELECT ON party_account_link_events TO metafarm_app;
REVOKE ALL ON FUNCTION party_account_links_guard(), party_account_links_proposed() FROM PUBLIC;
