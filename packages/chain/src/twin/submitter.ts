/**
 * Transaction submission for user-signed transfers. Not implemented in this release, and built to
 * fail closed: every missing piece (explicit enablement, a signer for fee payment, mainnet
 * permission) disables it with a reason, and even with all of them present it stays disabled
 * (`not_implemented`) until a reviewed implementation replaces this module.
 */
import { MAINNETS, SubmissionDisabledError, type Network, type SubmissionUnavailableReason, type TransactionSubmitter } from "@metafarm/domain";

export interface SubmitterConfig {
  /** An explicit switch; absent or false disables submission. */
  enabled?: boolean;
  signerConfigured: boolean;
  network: Network;
  mainnetEnabled: boolean;
}

export function submissionUnavailableReason(cfg: SubmitterConfig): SubmissionUnavailableReason {
  if (cfg.enabled !== true) return "not_enabled";
  if (!cfg.signerConfigured) return "no_signer";
  if (MAINNETS.includes(cfg.network) && !cfg.mainnetEnabled) return "mainnet_blocked";
  return "not_implemented";
}

export function createTransactionSubmitter(cfg: SubmitterConfig): TransactionSubmitter {
  const reason = submissionUnavailableReason(cfg);
  return {
    available: false,
    reason,
    async submit() {
      throw new SubmissionDisabledError(reason);
    },
  };
}
