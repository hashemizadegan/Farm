import { describe, expect, it } from "vitest";
import { mapTilesConfig } from "./providers";

describe("web map tiles at runtime", () => {
  const style = "https://tiles.example.org/style.json";
  it("uses a tile provider only when the build-time check enabled it", () => {
    expect(mapTilesConfig({ state: "enabled", styleUrl: style, attribution: "© Example" })).toEqual({ styleUrl: style, attribution: "© Example" });
    expect(mapTilesConfig({ state: "disabled", styleUrl: style, attribution: "© Example" })).toEqual({ styleUrl: undefined, attribution: undefined });
    expect(mapTilesConfig({ state: undefined, styleUrl: style })).toEqual({ styleUrl: undefined, attribution: undefined });
    expect(mapTilesConfig({})).toEqual({ styleUrl: undefined, attribution: undefined });
  });

  it("leaves attribution to the style when it is declared from-style", () => {
    expect(mapTilesConfig({ state: "enabled", styleUrl: style, attribution: "from-style" })).toEqual({ styleUrl: style, attribution: undefined });
  });
});
