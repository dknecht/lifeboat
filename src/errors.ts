import * as Data from "effect/Data";

// ── Infrastructure failures ──────────────────────────────────────────────────

export class DbError extends Data.TaggedError("DbError")<{ readonly cause: unknown }> {}

export class BlobError extends Data.TaggedError("BlobError")<{ readonly cause: unknown }> {}

/** The network request itself failed: DNS, TLS, connection reset, or timeout. */
export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly url: string;
  readonly cause: unknown;
}> {}

// ── Domain failures ──────────────────────────────────────────────────────────

/** Cloudflare Email Sending refused or failed to accept a message. */
export class SendFailed extends Data.TaggedError("SendFailed")<{
  readonly code?: string;
  readonly cause: unknown;
}> {}

/** Entra ID or Microsoft Graph answered with an error, or could not be reached. */
export class GraphError extends Data.TaggedError("GraphError")<{
  readonly message: string;
  /** HTTP status, or 0 when no response was received. */
  readonly status: number;
}> {}

export class GraphNotConfigured extends Data.TaggedError("GraphNotConfigured")<{}> {
  readonly message = "Microsoft Graph is not configured.";
}

/** Sign-in was refused: the credentials are wrong, or the account is locked after repeated failures. */
export class LoginRejected extends Data.TaggedError("LoginRejected")<{
  readonly reason: "invalid" | "locked";
}> {}

/** A Cloudflare Access token was missing something or failed verification. `reason` is for logs. */
export class AccessRejected extends Data.TaggedError("AccessRejected")<{ readonly reason: string }> {}

/** A passkey ceremony failed: the challenge expired, the response did not verify, or the passkey is unknown. */
export class PasskeyRejected extends Data.TaggedError("PasskeyRejected")<{ readonly message: string }> {}

/** A failover transition was refused or a DNS change failed. */
export class FailoverError extends Data.TaggedError("FailoverError")<{ readonly message: string }> {}

// ── HTTP API failures ────────────────────────────────────────────────────────

/** A request the API refuses, carrying the status and the message shown to the user. */
export class ApiError extends Data.TaggedError("ApiError")<{
  readonly status: 400 | 401 | 403 | 404 | 409 | 415 | 429 | 502;
  readonly message: string;
  /** A stable identifier the web client can act on, where the status alone is not enough. */
  readonly code?: "access_required";
}> {}

export const badRequest = (message: string) => new ApiError({ status: 400, message });
export const unauthorized = () => new ApiError({ status: 401, message: "Sign in to continue." });

/** The caller is known, but this route only admits people who came through Cloudflare Access. */
export const accessRequired = () =>
  new ApiError({ status: 401, code: "access_required", message: "Sign in through Cloudflare Access to continue." });

export const forbidden = () => new ApiError({ status: 403, message: "Administrator access is required." });
export const notFound = (message: string) => new ApiError({ status: 404, message });
export const conflict = (message: string) => new ApiError({ status: 409, message });
