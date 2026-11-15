import { Badge } from "@cloudflare/kumo/components/badge";
import { Banner } from "@cloudflare/kumo/components/banner";
import { Loader } from "@cloudflare/kumo/components/loader";
import { LifebuoyIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { FailoverState, Person } from "../api/schemas";
import { initials } from "../lib/format";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

const NOTICE_VARIANT = { error: "error", warn: "alert", info: "default" } as const;

/** An inline message about something that just happened or needs attention. */
export function Notice({ kind, children }: { kind: keyof typeof NOTICE_VARIANT; children: ReactNode }) {
  return (
    <div role={kind === "error" ? "alert" : "status"}>
      <Banner size="sm" variant={NOTICE_VARIANT[kind]}>
        {children}
      </Banner>
    </div>
  );
}

// Port is red and starboard is green: an outage shows the red light, standby the green.
const STATE_BADGE = {
  standby: { variant: "success", label: "Standby" },
  active: { variant: "error", label: "Outage mode" },
  recovering: { variant: "warning", label: "Recovering" },
} as const;

export function StateBadge({ state }: { state: FailoverState }) {
  const badge = STATE_BADGE[state];

  return (
    <Badge variant={badge.variant} appearance="dot">
      {badge.label}
    </Badge>
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
  <div role="status" className="flex items-center justify-center gap-2 p-10 text-sm text-kumo-subtle">
    <Loader size="sm" />
    {label}
  </div>
);

export const Brand = () => (
  <span className="flex items-center gap-2 font-display text-[26px] leading-none tracking-wide uppercase">
    <LifebuoyIcon weight="bold" className="size-6 text-kumo-brand" aria-hidden="true" />
    Lifeboat
  </span>
);

/** A page or panel heading in the stencilled lettering used on a hull. */
export const Stencil = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cx("font-display leading-none tracking-wide uppercase", className)}>{children}</span>
);
