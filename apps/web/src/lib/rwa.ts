/** Display helpers for the real-world asset screens. Pure, so they are unit tested. */

/** A long base58 address as its first and last characters, e.g. "7xKX…9fQ2". Full value stays in the title. */
export function shortAddress(address: string | null | undefined, keep = 4): string | null {
  if (!address) return null;
  return address.length <= keep * 2 + 1 ? address : `${address.slice(0, keep)}…${address.slice(-keep)}`;
}

type Tone = "ok" | "pending" | "problem" | "neutral";

/** How an asset's lifecycle status reads at a glance. */
export function assetTone(status: string): Tone {
  if (status === "active" || status === "verified") return "ok";
  if (status === "draft") return "pending";
  if (status === "suspended") return "problem";
  return "neutral";
}

/** How a registration's status reads at a glance; `exception` always needs a person. */
export function registrationTone(status: string): Tone {
  if (status === "completed") return "ok";
  if (status === "exception") return "problem";
  if (status === "cancelled") return "neutral";
  return "pending";
}

/** How a compressed NFT leaf's status reads at a glance. */
export function leafTone(status: string): Tone {
  if (status === "active") return "ok";
  if (status === "frozen") return "problem";
  if (status === "retired") return "neutral";
  return "pending";
}

/** Solana explorer link for an address or asset on a network this platform uses; null for anything else. */
export function explorerUrl(network: string, address: string | null | undefined): string | null {
  if (!address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;
  if (network === "solana-devnet") return `https://explorer.solana.com/address/${address}?cluster=devnet`;
  if (network === "solana-mainnet") return `https://explorer.solana.com/address/${address}`;
  return null;
}

/** Testnets are labelled as such wherever a network is shown. */
export const isTestnet = (network: string) => network !== "solana-mainnet" && network !== "tron-mainnet";
