export function seasonTone(status: string): "ok" | "pending" | "neutral" {
  return status === "active" ? "ok" : status === "planned" ? "pending" : "neutral";
}
