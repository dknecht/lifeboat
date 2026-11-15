import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Failure } from "./schemas";

/** A request the API refused, or one that never got a usable answer. `message` is safe to show. */
export class ApiFailure extends Error {
  constructor(
    message: string,
    /** The HTTP status, or 0 when there was no response. */
    readonly status: number,
    /** A stable identifier from the API for failures the interface handles specially. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

const decodeFailure = Schema.decodeUnknownOption(Failure);

async function send<S extends Schema.ConstraintDecoder<unknown>>(path: string, schema: S, init: RequestInit): Promise<S["Type"]> {
  const response = await fetch(`/api${path}`, init).catch(() => {
    throw new ApiFailure("Lifeboat could not be reached. Check your connection and try again.", 0);
  });

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const failure = Option.getOrUndefined(decodeFailure(payload));

    throw new ApiFailure(failure?.error ?? `The request failed (HTTP ${response.status}).`, response.status, failure?.code);
  }

  const decoded = Schema.decodeUnknownOption(schema)(payload);

  if (Option.isNone(decoded)) {
    throw new ApiFailure("Lifeboat sent a response this page does not understand. Reload and try again.", response.status);
  }

  return decoded.value;
}

/** Reads from the API and decodes the response. */
export const get = <S extends Schema.ConstraintDecoder<unknown>>(path: string, schema: S) => send(path, schema, { method: "GET" });

/** Writes to the API with a JSON body and decodes the response. */
export const post = <S extends Schema.ConstraintDecoder<unknown>, Body extends object>(path: string, schema: S, body?: Body) =>
  send(path, schema, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

/** The message to show for anything a query or mutation threw. */
export const messageOf = (error: Error | null) => error?.message ?? "";
