export const dueTone = (state: string): "ok" | "pending" | "problem" => (state === "overdue" ? "problem" : state === "soon" ? "pending" : "ok");
