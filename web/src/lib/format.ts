import type { Person } from "../api/schemas";

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A short timestamp for lists: the time for today's mail, the date for anything older. */
export function shortDate(ms: number): string {
  const date = new Date(ms);

  return date.toDateString() === new Date().toDateString() ? time.format(date) : day.format(date);
}

export const fullDate = (ms: number) => full.format(new Date(ms));

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const displayName = (person: Person) => person.name || person.address;

export const fullAddress = (person: Person) => (person.name ? `${person.name} <${person.address}>` : person.address);

/** Up to two initials for an avatar, taken from the name or, failing that, the address. */
export function initials(person: Person): string {
  const words = (person.name || person.address.split("@")[0] || "?").split(/[\s._-]+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word.charAt(0).toUpperCase());

  return letters.join("") || "?";
}

/** Splits a typed recipient list on commas, semicolons, and whitespace. */
export const splitAddresses = (value: string) => value.split(/[,;\s]+/).filter(Boolean);
