import { D39_DISCLOSURE_ID, D39_SIMULATION_DISCLOSURE } from "@/lib/yield";

/**
 * D-39 simulation banner (owner-adopted wording, 2026-10-22). Mounted once, at the top of every `/yield` view, by
 * app/yield/layout.tsx. Shown verbatim and in English in every locale: no translation of this text is approved.
 */
export function YieldSimulationDisclosure() {
  return (
    <div className="mf-notice mf-notice--warning yield-disclosure" role="note" lang="en" dir="ltr" data-disclosure={D39_DISCLOSURE_ID}>
      <strong>{D39_SIMULATION_DISCLOSURE.split(":")[0]}:</strong>
      {D39_SIMULATION_DISCLOSURE.slice(D39_SIMULATION_DISCLOSURE.indexOf(":") + 1)}
    </div>
  );
}
