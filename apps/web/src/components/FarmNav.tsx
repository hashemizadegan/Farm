"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  ["", "Overview"],
  ["/boundary", "Boundary"],
  ["/scenarios", "Crop scenarios"],
  ["/observations", "Observations"],
  ["/alerts", "Alerts"],
  ["/scene", "3D scene"],
] as const;

export function FarmNav({ farmId }: { farmId: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Farm sections" className="farm-tabs">
      <ul>
        {TABS.map(([suffix, label]) => {
          const href = `/farms/${farmId}${suffix}`;
          return (
            <li key={suffix}>
              <Link href={href} aria-current={pathname === href ? "page" : undefined}>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
