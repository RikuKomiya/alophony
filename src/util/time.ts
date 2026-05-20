export function nowIso(): string {
  return new Date().toISOString();
}

export function addMsIso(ms: number, from = new Date()): string {
  return new Date(from.getTime() + ms).toISOString();
}

export function isPastIso(value: string, at = new Date()): boolean {
  return Date.parse(value) <= at.getTime();
}
