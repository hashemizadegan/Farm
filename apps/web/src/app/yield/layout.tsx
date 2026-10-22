import type { ReactNode } from "react";
import { YieldSimulationDisclosure } from "@/components/yield/YieldSimulationDisclosure";

/** Every `/yield` view starts with the D-39 simulation banner. */
export default function YieldLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <YieldSimulationDisclosure />
      {children}
    </>
  );
}
