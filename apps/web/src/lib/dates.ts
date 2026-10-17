/** Today's calendar day on this device, as YYYY-MM-DD. */
export function localToday(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function shiftDay(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The first day of the week containing `date`; `startsOn` is 0 (Sunday) … 6 (Saturday). */
export function weekStart(date: string, startsOn: number): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return shiftDay(date, -((dow - startsOn + 7) % 7));
}
