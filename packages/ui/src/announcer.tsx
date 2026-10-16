"use client";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type Politeness = "polite" | "assertive";
type Announce = (message: string, politeness?: Politeness) => void;

const AnnouncerContext = createContext<Announce>(() => undefined);

/**
 * App-wide live regions for status messages (WCAG 2.2 SC 4.1.3).
 * Regions are rendered once and never unmounted; screen readers often miss
 * announcements in regions inserted at the same time as their content.
 */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const announce = useCallback<Announce>((message, politeness = "polite") => {
    const set = politeness === "assertive" ? setAssertive : setPolite;
    // Clear first so repeating the same message is announced again.
    set("");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => set(message), 50);
  }, []);

  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      <div className="mf-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-testid="announcer-polite">
        {polite}
      </div>
      <div className="mf-visually-hidden" role="alert" aria-live="assertive" aria-atomic="true" data-testid="announcer-assertive">
        {assertive}
      </div>
    </AnnouncerContext.Provider>
  );
}

export function useAnnounce(): Announce {
  return useContext(AnnouncerContext);
}
