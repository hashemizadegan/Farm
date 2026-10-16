// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnnouncerProvider, useAnnounce } from "./announcer";
import { ErrorSummary, ProvenanceBadge, TextField } from "./components";

describe("TextField", () => {
  it("associates label, hint and error with the input", () => {
    render(<TextField label="Latitude" hint="Decimal degrees" error="Must be between -90 and 90" />);
    const input = screen.getByLabelText("Latitude");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = input.getAttribute("aria-describedby")!.split(" ");
    expect(describedBy).toHaveLength(2);
    expect(document.getElementById(describedBy[1]!)!.textContent).toBe("Must be between -90 and 90");
  });
});

describe("ProvenanceBadge", () => {
  it("conveys provenance in text, not colour alone", () => {
    render(<ProvenanceBadge label="user-entered" />);
    expect(screen.getByText(/User-entered/).textContent).toMatch(/not independently verified/);
  });
});

describe("ErrorSummary", () => {
  it("renders an alert linking to fields", () => {
    render(<ErrorSummary errors={[{ field: "lat", message: "Enter a latitude" }]} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Enter a latitude" }).getAttribute("href")).toBe("#lat");
  });
});

describe("AnnouncerProvider", () => {
  it("announces status messages in a persistent live region", async () => {
    vi.useFakeTimers();
    let announce: ReturnType<typeof useAnnounce> = () => undefined;
    function Probe() {
      announce = useAnnounce();
      return null;
    }
    render(
      <AnnouncerProvider>
        <Probe />
      </AnnouncerProvider>,
    );
    act(() => announce("Boundary saved"));
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByTestId("announcer-polite").textContent).toBe("Boundary saved");
    vi.useRealTimers();
  });
});
