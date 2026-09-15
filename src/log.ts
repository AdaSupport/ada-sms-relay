export function log(event: string, fields: Record<string, unknown> = {}, level: "info" | "warn" | "error" = "info"): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function digitsOnly(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}
