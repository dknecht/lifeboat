/**
 * Cloudflare Access in front of everything Lifeboat deploys.
 *
 * It is created only when an allow-list is given at deploy time:
 *
 *   ACCESS_ALLOW_EMAILS=someone@example.org,other@example.org
 *   ACCESS_ALLOW_DOMAINS=example.com
 *
 * With either set, `alchemy deploy` puts an Access application in front of the Worker and another
 * in front of the landing page, each admitting those people. Pair it with AUTH_MODE=access so that Lifeboat signs people in
 * from the identity Access has verified.
 */
import * as Cloudflare from "@alchemy.run/cloudflare";

const listOf = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

// Read when the stack is evaluated for a deploy. Inside the running Worker the result is not used.
const deployEnv = globalThis.process?.env ?? {};

const allowed = [
  ...listOf(deployEnv.ACCESS_ALLOW_EMAILS).map((email) => ({ email })),
  ...listOf(deployEnv.ACCESS_ALLOW_DOMAINS).map((emailDomain) => ({ emailDomain })),
];

const policies = [{ name: "Lifeboat allow-list", decision: "allow" as const, include: allowed }];

/** The Access settings for a Worker, or undefined when no allow-list was given. */
export const gateFor = (name: string): Cloudflare.WorkerProps["access"] =>
  allowed.length > 0 ? { name, policies } : undefined;
