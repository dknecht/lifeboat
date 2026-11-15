import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import type { Person } from "../api/schemas";
import { initials } from "../lib/format";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

const BUTTON_STYLE = {
  primary: "bg-accent text-accent-ink border-accent hover:brightness-110 font-semibold",
  secondary: "bg-surface text-ink border-line hover:bg-sunken",
  danger: "bg-danger text-surface border-danger hover:brightness-110 font-semibold",
  ghost: "bg-transparent text-ink border-transparent hover:bg-sunken",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof BUTTON_STYLE;
  /** Shows a spinner and blocks further clicks while an action is running. */
  busy?: boolean;
}

export function Button({ variant = "secondary", busy = false, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md border px-3.5 py-2 text-sm transition disabled:cursor-default disabled:opacity-55",
        BUTTON_STYLE[variant],
        className,
      )}
    >
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

const CONTROL = "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm placeholder:text-muted";

export const Input = ({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...rest} className={cx(CONTROL, className)} />
);

export const Textarea = ({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...rest} className={cx(CONTROL, "min-h-56 resize-y", className)} />
);

/** A labelled form control. `htmlFor` must match the control's id. */
export function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-semibold">
        {label}
      </label>
      {children}
    </div>
  );
}

const NOTICE_STYLE = {
  error: "bg-danger-soft text-danger",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
};

export function Notice({ kind, children }: { kind: keyof typeof NOTICE_STYLE; children: ReactNode }) {
  return (
    <div role={kind === "error" ? "alert" : "status"} className={cx("rounded-md px-3.5 py-2.5 text-sm", NOTICE_STYLE[kind])}>
      {children}
    </div>
  );
}

const PILL_STYLE = {
  standby: "bg-ok-soft text-ok",
  active: "bg-danger-soft text-danger",
  recovering: "bg-warn-soft text-warn",
  neutral: "bg-sunken text-muted",
};

export function Pill({ tone, children }: { tone: keyof typeof PILL_STYLE; children: ReactNode }) {
  return (
    <span className={cx("inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap", PILL_STYLE[tone])}>
      {children}
    </span>
  );
}

// A small fixed palette so that the same correspondent always gets the same colour.
const AVATAR_TINTS = ["bg-[#2f6f8f]", "bg-[#7a5ea8]", "bg-[#2f7d5b]", "bg-[#a8553a]", "bg-[#4a5fa8]", "bg-[#8a6d1f]"];

export function Avatar({ person }: { person: Person }) {
  const sum = [...person.address].reduce((total, char) => total + char.charCodeAt(0), 0);

  return (
    <span
      aria-hidden="true"
      className={cx(
        "grid size-9 shrink-0 place-items-center rounded-full text-[13px] font-semibold text-white",
        AVATAR_TINTS[sum % AVATAR_TINTS.length],
      )}
    >
      {initials(person)}
    </span>
  );
}

export const Spinner = ({ label }: { label: string }) => (
  <div role="status" className="flex items-center justify-center gap-2 p-10 text-sm text-muted">
    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
    {label}
  </div>
);

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2 font-display text-2xl leading-none uppercase">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="size-6 text-accent" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="4" />
        <path d="m5.6 5.6 3.6 3.6m5.6 5.6 3.6 3.6m0-12.8-3.6 3.6m-5.6 5.6-3.6 3.6" />
      </svg>
      <span className={compact ? "sr-only" : ""}>Lifeboat</span>
    </span>
  );
}

export { cx };
