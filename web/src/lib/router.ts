import { useEffect, useState, useSyncExternalStore } from "react";
import type { Folder } from "../api/schemas";

/** Where the interface is. Routes live in the URL hash so that invite links work on any host. */
export type Route =
  | { readonly name: "login" }
  | { readonly name: "invite"; readonly token: string }
  | { readonly name: "mail"; readonly folder: Folder; readonly messageId: string | null }
  | { readonly name: "admin" };

export function parseRoute(hash: string): Route {
  const [first = "", second = ""] = hash.replace(/^#\/?/, "").split("/");

  if (first === "invite" && second) return { name: "invite", token: second };

  if (first === "login") return { name: "login" };

  if (first === "admin") return { name: "admin" };

  return { name: "mail", folder: first === "sent" ? "sent" : "inbox", messageId: second || null };
}

export function hrefFor(route: Route): string {
  if (route.name === "invite") return `#/invite/${route.token}`;

  if (route.name === "mail") return `#/${route.folder}${route.messageId ? `/${route.messageId}` : ""}`;

  return `#/${route.name}`;
}

export const navigate = (route: Route) => {
  location.hash = hrefFor(route);
};

function subscribe(onChange: () => void) {
  addEventListener("hashchange", onChange);

  return () => removeEventListener("hashchange", onChange);
}

/** The current hash, re-rendering the caller whenever it changes. */
export const useHash = () => useSyncExternalStore(subscribe, () => location.hash);

/** Names the browser tab after the view that is open. */
export function useTitle(title: string) {
  useEffect(() => {
    const previous = document.title;

    document.title = `${title} · Lifeboat`;

    // Closing a view, such as an open message, hands the tab title back to the view beneath it.
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** Returns `value` once it has stopped changing for `delayMs`, so that typing does not fire a request per key. */
export function useDebounced(value: string, delayMs = 250): string {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);

    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
