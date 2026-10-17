import { outlinePath } from "@/lib/outline";

/**
 * Draws a farm's real boundary outline as a small mark: the brand's signature.
 * Longitude is scaled by cos(latitude) so shapes keep their true proportions,
 * and north is up. Farms without a validated boundary get a dashed square
 * ("not surveyed yet"), so the mark always says something true.
 */
export function PlotOutline({
  outline,
  size = 40,
  title,
  className,
}: {
  outline: number[][] | null | undefined;
  size?: number;
  /** When set, the mark is announced; otherwise it is decorative. */
  title?: string;
  className?: string;
}) {
  const d = outline && outline.length >= 4 ? outlinePath(outline) : undefined;
  const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": true as const };
  return (
    <svg className={["plot", d ? "" : "plot--pending", className].filter(Boolean).join(" ")} viewBox="0 0 100 100" width={size} height={size} focusable="false" {...a11y}>
      {d ? (
        <path className="plot__shape" d={d} pathLength={1} />
      ) : (
        <rect className="plot__shape" x="18" y="18" width="64" height="64" rx="3" />
      )}
    </svg>
  );
}
