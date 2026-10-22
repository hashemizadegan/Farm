/** Migration 0025 (Y12, D-29), checked from the SQL itself; behaviour is in the API integration tests. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PARTY_LINK_ERROR_CODES, PartyLinkError, toPartyLinkError } from "./repositories/party-links";

const here = path.dirname(fileURLToPath(import.meta.url));
const up = readFileSync(path.resolve(here, "../migrations/0025_party_account_links.up.sql"), "utf8").replace(/--[^\n]*/g, "");
const down = readFileSync(path.resolve(here, "../migrations/0025_party_account_links.down.sql"), "utf8");

describe("migration 0025: account-to-party links (Y12)", () => {
  it("never creates or edits a party, and never reads parties.user_id", () => {
    expect(up).not.toMatch(/INSERT INTO parties|UPDATE parties|user_id\s*=\s*p\.|parties\.user_id/i);
    expect(up).toContain("FOREIGN KEY (tenant_id, party_id) REFERENCES parties(tenant_id, id) ON DELETE RESTRICT");
  });

  it("enforces consent, four-eyes authorisation, terminal revocation and one live link per party and per user", () => {
    expect(up).toContain("CONSTRAINT party_account_links_not_self_proposed CHECK (proposed_by <> user_id)");
    expect(up).toContain("CONSTRAINT party_account_links_four_eyes CHECK (authorised_by IS NULL OR (authorised_by <> proposed_by AND authorised_by <> user_id))");
    expect(up).toContain("CHECK (status NOT IN ('consented', 'active') OR consented_at IS NOT NULL)");
    expect(up).toMatch(/party_account_links_party_live_idx ON party_account_links \(tenant_id, party_id\) WHERE status <> 'revoked'/);
    expect(up).toMatch(/party_account_links_user_live_idx ON party_account_links \(tenant_id, user_id\) WHERE status <> 'revoked'/);
    expect(up).toMatch(/ELSIF OLD.status IN \('proposed', 'consented', 'active'\) AND NEW.status = 'revoked'/);
  });

  it("keeps the event log append-only and out of the application role's hands", () => {
    expect(up).toContain("CREATE TRIGGER party_account_link_events_append_only BEFORE UPDATE OR DELETE ON party_account_link_events");
    expect(up).toContain("GRANT SELECT ON party_account_link_events TO metafarm_app;");
    expect(up).not.toMatch(/GRANT[^;]*DELETE[^;]*party_account/);
    expect(up).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("is reversible and maps refusals to stable codes", () => {
    for (const t of ["party_account_link_events", "party_account_links"]) expect(down).toContain(`DROP TABLE IF EXISTS ${t};`);
    for (const m of up.matchAll(/HINT = 'link:([a-z_]+)'/g)) expect(PARTY_LINK_ERROR_CODES as readonly string[]).toContain(m[1]);
    const e = (x: object) => toPartyLinkError(Object.assign(new Error("m"), x)) as PartyLinkError;
    expect(e({ code: "23514", constraint: "party_account_links_four_eyes" }).code).toBe("four_eyes");
    expect(e({ code: "23514", hint: "link:invalid_transition" }).code).toBe("invalid_transition");
    expect(e({ code: "23505" }).code).toBe("duplicate");
    const other = new Error("x");
    expect(toPartyLinkError(other)).toBe(other);
  });
});
