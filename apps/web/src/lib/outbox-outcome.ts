/** What to do with a queued entry after trying to send it. */
export type Outcome = "sent" | "retry-later" | "failed";

/**
 * Network trouble, an expired sign-in, rate limiting and server errors are worth retrying later;
 * other refusals (the task was cancelled meanwhile, a validation error) need the person's attention.
 */
export function outcomeOf(status: number | "network"): Outcome {
  if (status === "network") return "retry-later";
  if (status >= 200 && status < 300) return "sent";
  if (status === 401 || status === 408 || status === 429 || status >= 500) return "retry-later";
  return "failed";
}

