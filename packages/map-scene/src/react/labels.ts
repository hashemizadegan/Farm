/** Every visible or announced string in the scene components; English defaults, overridable by the app. */
export interface SceneLabels {
  heading: string;
  illustrativeOnly: string;
  /** Replaces the server's disclaimer text when set (e.g. a translation). */
  disclaimer?: string;
  controls: string;
  view: string;
  view3d: string;
  viewList: string;
  quality: string;
  qualityLevels: { low: string; medium: string; high: string };
  qualitySet: (level: string) => string;
  unavailable: (reason: string) => string;
  disabledReason: string;
  contextLost: string;
  contextLostAnnounce: string;
  loading: string;
  ready: (count: number) => string;
  hint: string;
  selectedHeading: string;
  name: string;
  position: string;
  positionValue: (east: string, north: string) => string;
  provenance: string;
  selectedAnnounce: (name: string) => string;
  listHeading: (count: number) => string;
  filter: string;
  caption: (page: number, pages: number) => string;
  element: string;
  east: string;
  north: string;
  action: string;
  select: string;
  selected: string;
  pages: string;
  previous: string;
  next: string;
  pageOf: (page: number, pages: number) => string;
  /** Display text for a provenance label value. */
  provenanceName?: (label: string) => string;
}

export const EN_SCENE_LABELS: SceneLabels = {
  heading: "Farm scene",
  illustrativeOnly: "Illustrative only.",
  controls: "Scene controls",
  view: "View",
  view3d: "3D view",
  viewList: "List view",
  quality: "Quality",
  qualityLevels: { low: "Low", medium: "Medium", high: "High" },
  qualitySet: (l) => `Rendering quality set to ${l}.`,
  unavailable: (r) => `The 3D view is not available on this device (${r}). All scene information is shown in the list below.`,
  disabledReason: "3D view disabled",
  contextLost: "the graphics context was lost",
  contextLostAnnounce: "3D view stopped; showing the list view instead.",
  loading: "Loading 3D view…",
  ready: (n) => `3D view ready with ${n} elements.`,
  hint: "Drag to orbit, scroll to zoom. Every element can also be selected from the list view.",
  selectedHeading: "Selected element",
  name: "Name",
  position: "Position",
  positionValue: (e, n) => `${e} m east, ${n} m north of origin`,
  provenance: "Provenance",
  selectedAnnounce: (name) => `Selected ${name}.`,
  listHeading: (n) => `Scene elements (${n})`,
  filter: "Filter elements",
  caption: (p, n) => `Scene elements, page ${p} of ${n}. Positions are metres from the farm origin.`,
  element: "Element",
  east: "East (m)",
  north: "North (m)",
  action: "Action",
  select: "Select",
  selected: "Selected",
  pages: "Scene element pages",
  previous: "Previous page",
  next: "Next page",
  pageOf: (p, n) => `Page ${p} of ${n}`,
};
