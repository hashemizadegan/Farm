import { describe, expect, it } from "vitest";
import { createWorkspaceSchema, workspaceSlug } from "./schemas";

describe("workspaceSlug", () => {
  it("lowercases, strips accents and joins words with dashes", () => {
    expect(workspaceSlug("Ferme du Lac", "1a2b3c4d")).toBe("ferme-du-lac-1a2b3c4d");
    expect(workspaceSlug("Café Élan", "00000000")).toBe("cafe-elan-00000000");
  });

  it("falls back to 'workspace' when nothing URL-safe remains", () => {
    expect(workspaceSlug("مزرعه", "abcdef01")).toBe("workspace-abcdef01");
    expect(workspaceSlug("!!!", "abcdef01")).toBe("workspace-abcdef01");
  });

  it("stays within the database slug rule", () => {
    const slug = workspaceSlug("x".repeat(300) + " farm", "deadbeef");
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{1,62}$/);
    expect(workspaceSlug("--- leading", "deadbeef")).toBe("leading-deadbeef");
  });
});

describe("createWorkspaceSchema", () => {
  it("trims and requires a name", () => {
    expect(createWorkspaceSchema.parse({ name: "  My farm " }).name).toBe("My farm");
    expect(createWorkspaceSchema.safeParse({ name: "   " }).success).toBe(false);
  });
});
