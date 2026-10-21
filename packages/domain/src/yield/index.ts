/**
 * Real yield distribution: pure, deterministic building blocks (plan: docs/delivery/
 * real-yield-distribution-plan.md, revision 4). Exported as `@metafarm/domain/yield`, separately from the
 * package barrel. Nothing here performs I/O, signs, submits or holds policy defaults.
 */
export * from "./cycle";
export * from "./records";
export * from "./gates";
export * from "./evidence";
export * from "./attestation";
export * from "./quorum";
