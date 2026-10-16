import type { ReactNode } from "react";
import { FarmNav } from "@/components/FarmNav";

export default async function FarmLayout({ children, params }: { children: ReactNode; params: Promise<{ farmId: string }> }) {
  const { farmId } = await params;
  return (
    <>
      <FarmNav farmId={farmId} />
      {children}
    </>
  );
}
