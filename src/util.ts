export const now = () => Date.now();

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));

  return toBase64Url(buf);
}

export function toBase64Url(buf: Uint8Array): string {
  return toBase64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function toBase64(buf: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;

  for (let i = 0; i < buf.length; i += chunk) {
    s += String.fromCharCode(...buf.subarray(i, i + chunk));
  }

  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);

  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;

  for (let i = 0; i < ea.length; i++) diff |= ea[i]! ^ (eb[i % (eb.length || 1)] ?? 0);

  return diff === 0;
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

const ADDRESS_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export function isValidAddress(address: string): boolean {
  return address.length <= 254 && ADDRESS_RE.test(address);
}

export function snippetOf(text: string, max = 160): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function intVar(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? "", 10);

  return Number.isFinite(n) && n > 0 ? n : fallback;
}
