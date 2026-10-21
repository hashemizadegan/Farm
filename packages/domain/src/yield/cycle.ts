/**
 * Yield cycle lifecycle (Real Yield Distribution plan, revision 4, §2.1). Vocabulary and the
 * transition table only: no I/O, no policy values, no economic defaults.
 *
 *   draft ─lock─► inputs_locked ─calculate─► calculated ─submit─► under_review ─approve─► approved ─publish─► published
 *
 * Every state before `published` can be cancelled (by an approver) or abandoned (by the system after an
 * inactivity deadline, which is a policy decision, D-10, and so is not known here). A published cycle is
 * closed with a reason, disputed, or superseded by an approved correction.
 *
 * `funded` and `distributing` are future phases. They need separate approvals the plan does not grant,
 * so in this library `fund` and `distribute` are always refused, and a simulation cycle can never be
 * funded at all.
 */

export const YIELD_CYCLE_STATES = [
  "draft",
  "inputs_locked",
  "calculated",
  "under_review",
  "approved",
  "published",
  "funded",
  "distributing",
  "disputed",
  "closed",
  "cancelled",
  "abandoned",
  "superseded",
] as const;
export type YieldCycleState = (typeof YIELD_CYCLE_STATES)[number];

export const YIELD_TERMINAL_STATES = ["closed", "cancelled", "abandoned", "superseded"] as const satisfies readonly YieldCycleState[];

/** States that need separate funding and execution approval; never entered by this library. */
export const YIELD_FUTURE_STATES = ["funded", "distributing"] as const satisfies readonly YieldCycleState[];

/** States in which a cycle may be cancelled or abandoned: everything before publication. */
export const YIELD_PRE_PUBLICATION_STATES = ["draft", "inputs_locked", "calculated", "under_review", "approved"] as const satisfies readonly YieldCycleState[];

export const YIELD_CYCLE_COMMANDS = [
  "lock",
  "unlock",
  "calculate",
  "submit",
  "reject",
  "approve",
  "publish",
  "cancel",
  "expire",
  "close",
  "dispute",
  "dismiss",
  "supersede",
  "fund",
  "distribute",
] as const;
export type YieldCycleCommand = (typeof YIELD_CYCLE_COMMANDS)[number];

/** Who performs a command. Permissions that carry these roles are a separate decision (D-28). */
export type YieldActorRole = "preparer" | "reviewer" | "approver" | "dispute_raiser" | "dispute_authority" | "system";

/**
 * Why a published cycle was closed. `distributed` belongs to the future distribution phase; `simulation`
 * may only close a simulation cycle.
 */
export const YIELD_CLOSE_REASONS = ["no_distribution", "loss", "unfunded", "simulation", "distributed"] as const;
export type YieldCloseReason = (typeof YIELD_CLOSE_REASONS)[number];

export interface YieldTransition {
  command: YieldCycleCommand;
  from: YieldCycleState;
  /** `previous` means: back to the state the cycle was in before it was disputed. */
  to: YieldCycleState | "previous";
  actor: YieldActorRole;
  /** A future phase: refused by this library. */
  future?: true;
}

const pre = YIELD_PRE_PUBLICATION_STATES;

/** The complete table of allowed transitions. Anything not listed is refused. */
export const YIELD_TRANSITIONS: readonly YieldTransition[] = [
  { command: "lock", from: "draft", to: "inputs_locked", actor: "preparer" },
  { command: "unlock", from: "inputs_locked", to: "draft", actor: "preparer" },
  // Unlocking a calculated cycle invalidates its frozen artifact set (kept, never deleted).
  { command: "unlock", from: "calculated", to: "inputs_locked", actor: "preparer" },
  { command: "calculate", from: "inputs_locked", to: "calculated", actor: "preparer" },
  { command: "submit", from: "calculated", to: "under_review", actor: "preparer" },
  { command: "reject", from: "under_review", to: "inputs_locked", actor: "reviewer" },
  { command: "approve", from: "under_review", to: "approved", actor: "approver" },
  { command: "publish", from: "approved", to: "published", actor: "approver" },
  ...pre.map((from) => ({ command: "cancel" as const, from, to: "cancelled" as const, actor: "approver" as const })),
  ...pre.map((from) => ({ command: "expire" as const, from, to: "abandoned" as const, actor: "system" as const })),
  { command: "close", from: "published", to: "closed", actor: "approver" },
  { command: "dispute", from: "published", to: "disputed", actor: "dispute_raiser" },
  { command: "dismiss", from: "disputed", to: "previous", actor: "dispute_authority" },
  { command: "supersede", from: "published", to: "superseded", actor: "approver" },
  { command: "supersede", from: "disputed", to: "superseded", actor: "approver" },
  // Future phases: listed so the shape is fixed, always refused here.
  { command: "fund", from: "published", to: "funded", actor: "approver", future: true },
  { command: "distribute", from: "funded", to: "distributing", actor: "system", future: true },
  { command: "close", from: "distributing", to: "closed", actor: "approver", future: true },
  { command: "dispute", from: "funded", to: "disputed", actor: "dispute_raiser", future: true },
  { command: "dispute", from: "distributing", to: "disputed", actor: "dispute_raiser", future: true },
];

export type YieldTransitionErrorCode =
  | "invalid_transition"
  | "future_phase"
  | "simulation_not_fundable"
  | "close_reason_required"
  | "close_reason_not_allowed"
  | "previous_state_required"
  | "four_eyes";

export class YieldTransitionError extends Error {
  constructor(
    readonly code: YieldTransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "YieldTransitionError";
  }
}

export interface YieldTransitionContext {
  /** Whether the cycle is a simulation (never legally effective, never fundable). Always explicit. */
  simulation: boolean;
  /** Required for `close`. */
  closeReason?: YieldCloseReason;
  /** Required for `dismiss`: the state the cycle was in when it was disputed. */
  stateBeforeDispute?: YieldCycleState;
}

/** The transition rows for a state and command (at most one row matches a given pair). */
export function findYieldTransition(from: YieldCycleState, command: YieldCycleCommand): YieldTransition | undefined {
  return YIELD_TRANSITIONS.find((t) => t.from === from && t.command === command);
}

/**
 * The state a command moves a cycle to, or a YieldTransitionError. Refuses every transition not in the
 * table, every future-phase transition, funding of a simulation cycle, and `close` without a reason
 * allowed for this cycle.
 */
export function yieldTransitionTarget(from: YieldCycleState, command: YieldCycleCommand, ctx: YieldTransitionContext): YieldCycleState {
  if (typeof ctx?.simulation !== "boolean") throw new YieldTransitionError("invalid_transition", "the context must say whether the cycle is a simulation");
  if (command === "fund" && ctx.simulation) throw new YieldTransitionError("simulation_not_fundable", "a simulation cycle can never be funded");
  const t = findYieldTransition(from, command);
  if (!t) throw new YieldTransitionError("invalid_transition", `a yield cycle cannot ${command} from ${from}`);
  if (t.future) throw new YieldTransitionError("future_phase", `${command} from ${from} belongs to a future phase that is not approved`);

  if (command === "close") {
    const reason = ctx.closeReason;
    if (!reason) throw new YieldTransitionError("close_reason_required", "closing a cycle needs a reason");
    if (!(YIELD_CLOSE_REASONS as readonly string[]).includes(reason)) throw new YieldTransitionError("close_reason_not_allowed", `unknown close reason ${String(reason)}`);
    if (reason === "distributed") throw new YieldTransitionError("close_reason_not_allowed", "only a distributing cycle (a future phase) closes as distributed");
    if (reason === "simulation" && !ctx.simulation) throw new YieldTransitionError("close_reason_not_allowed", "only a simulation cycle closes with reason simulation");
  }

  if (t.to === "previous") {
    const back = ctx.stateBeforeDispute;
    if (!back) throw new YieldTransitionError("previous_state_required", "dismissing a dispute needs the state the cycle was in before it");
    const disputable = YIELD_TRANSITIONS.some((x) => x.command === "dispute" && x.from === back && !x.future);
    if (!disputable) throw new YieldTransitionError("invalid_transition", `a dispute cannot return a cycle to ${back}`);
    return back;
  }
  return t.to;
}

export function isTerminalYieldState(s: YieldCycleState): boolean {
  return (YIELD_TERMINAL_STATES as readonly YieldCycleState[]).includes(s);
}

/**
 * Four-eyes: the person who approves must not be the person who prepared. Both identities must be
 * given; an empty identity is refused rather than treated as "different".
 */
export function assertYieldFourEyes(preparedBy: string, approvedBy: string): void {
  if (!preparedBy || !approvedBy) throw new YieldTransitionError("four_eyes", "both the preparer and the approver must be identified");
  if (preparedBy === approvedBy) throw new YieldTransitionError("four_eyes", "the approver must not be the preparer");
}
