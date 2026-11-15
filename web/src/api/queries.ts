import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiFailure, del, get, post, put } from "./client";
import * as S from "./schemas";

/** Public facts about this deployment, including how people are expected to sign in. */
export const useStatus = () => useQuery({ queryKey: ["status"], queryFn: () => get("/status", S.Status), staleTime: 60_000 });

/** Where to send the browser so that Cloudflare Access signs the person in and returns them to `next`. */
export const accessLoginHref = (next: "admin" | "inbox") => `/api/admin/access-login?next=${next}`;

/** Cloudflare's own sign-out address for Access, which ends the Access session for this site. */
export const ACCESS_LOGOUT_HREF = "/cdn-cgi/access/logout";

/** The signed-in session, or null when nobody is signed in. */
export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      try {
        return await get("/auth/me", S.Session);
      } catch (error) {
        if (error instanceof ApiFailure && error.status === 401) return null;

        throw error;
      }
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function useLogin() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (credentials: { email: string; password: string }) =>
      post("/auth/login", S.LoginResult, credentials),
    onSuccess: () => client.invalidateQueries({ queryKey: ["session"] }),
  });
}

export function useLogout() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: () => post("/auth/logout", S.Done),
    onSettled: () => {
      client.clear();
    },
  });
}

export const useAcceptInvite = () =>
  useMutation({
    mutationFn: (input: { token: string; password: string }) =>
      post("/auth/accept-invite", S.InviteAccepted, input),
  });

// ── Passkeys ─────────────────────────────────────────────────────────────────

/** Signs in with a passkey: the server issues a challenge, the device signs it, the server checks it. */
export function usePasskeyLogin() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const challenge = await post("/auth/passkeys/login-options", S.PasskeyChallenge);
      const response = await startAuthentication({ optionsJSON: challenge.options });

      return post("/auth/passkeys/login", S.LoginResult, { challengeId: challenge.challengeId, response });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["session"] }),
  });
}

export const usePasskeys = () =>
  useQuery({ queryKey: ["passkeys"], queryFn: async () => (await get("/auth/passkeys", S.Passkeys)).passkeys });

/** Creates a passkey on this device and registers it under `name`. */
export function useAddPasskey() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async (name: string) => {
      const challenge = await post("/auth/passkeys/register-options", S.PasskeyChallenge);
      const response = await startRegistration({ optionsJSON: challenge.options });

      return post("/auth/passkeys/register", S.PasskeyAdded, { challengeId: challenge.challengeId, name, response });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["passkeys"] }),
  });
}

export function useDeletePasskey() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => del(`/auth/passkeys/${encodeURIComponent(id)}`, S.Done),
    onSuccess: () => client.invalidateQueries({ queryKey: ["passkeys"] }),
  });
}

/**
 * A folder's messages, newest first, refreshed every 30 seconds so new mail shows up unprompted.
 * `search` narrows the folder to messages containing those words.
 */
export function useFolder(folder: S.Folder, search = "") {
  return useInfiniteQuery({
    queryKey: ["messages", folder, search],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ folder });

      if (search) params.set("q", search);

      if (pageParam) params.set("cursor", pageParam);

      return get(`/messages?${params}`, S.MessageList);
    },
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 30_000,
    // Keep showing the previous results while a new search is on its way.
    placeholderData: (previous) => previous,
  });
}

/** The conversation a message belongs to. Opening it marks that message read, so the lists are refreshed. */
export function useThread(id: string | null) {
  const client = useQueryClient();

  return useQuery({
    queryKey: ["thread", id],
    enabled: id !== null,
    queryFn: async () => {
      const { messages } = await get(`/messages/${id}/thread`, S.Thread);

      void client.invalidateQueries({ queryKey: ["messages"] });

      return messages;
    },
    staleTime: 60_000,
  });
}

/** A message ready to send. `draftId` names the saved draft to remove once it has gone. */
export interface OutgoingMessage {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  inReplyToId?: string;
  draftId?: string;
  attachments: { filename: string; contentType: string; contentBase64: string }[];
}

export function useSendMessage() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (message: OutgoingMessage) => post("/messages", S.Sent, message),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["messages"] }),
        client.invalidateQueries({ queryKey: ["thread"] }),
        client.invalidateQueries({ queryKey: ["drafts"] }),
      ]),
  });
}

// ── Drafts ───────────────────────────────────────────────────────────────────

export const useDrafts = () =>
  useQuery({ queryKey: ["drafts"], queryFn: async () => (await get("/drafts", S.Drafts)).drafts });

/** What a draft holds, without the fields the server assigns. */
export interface DraftContent {
  id: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  text: string;
  inReplyToId: string | null;
}

export function useSaveDraft() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...content }: DraftContent) => put(`/drafts/${id}`, S.DraftSaved, content),
    onSuccess: () => client.invalidateQueries({ queryKey: ["drafts"] }),
  });
}

export function useDeleteDraft() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => del(`/drafts/${id}`, S.Done),
    onSuccess: () => client.invalidateQueries({ queryKey: ["drafts"] }),
  });
}

// ── Admin ────────────────────────────────────────────────────────────────────

export const useOverview = () =>
  useQuery({ queryKey: ["admin", "overview"], queryFn: () => get("/admin/overview", S.Overview), refetchInterval: 15_000 });

export const useAdminUsers = () =>
  useQuery({ queryKey: ["admin", "users"], queryFn: () => get("/admin/users", S.AdminUsers) });

export const useHeldMail = () =>
  useQuery({ queryKey: ["admin", "held"], queryFn: () => get("/admin/held", S.HeldMail) });

export const useAuditLog = () =>
  useQuery({ queryKey: ["admin", "audit"], queryFn: () => get("/admin/audit", S.AuditLog) });

/** Wraps an admin action so that every admin view and the session state refresh afterwards. */
function useAdminAction<Input, Output>(action: (input: Input) => Promise<Output>) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: action,
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["admin"] }),
        client.invalidateQueries({ queryKey: ["session"] }),
      ]),
  });
}

export const useActivate = () =>
  useAdminAction((reason: string) => post("/admin/failover/activate", S.Transition, { reason }));

export const useDeactivate = () => useAdminAction(() => post("/admin/failover/deactivate", S.Transition));

export const useRunSync = () =>
  useAdminAction(() => post("/admin/sync/run", S.SyncRun, { retryFailed: true }));

export const useCreateUser = () =>
  useAdminAction((input: { email: string; displayName: string; role: string }) =>
    post("/admin/users", S.UserCreated, input),
  );

export const useInvite = () =>
  useAdminAction((input: { userId: string; send: boolean }) =>
    post(`/admin/users/${input.userId}/invite`, S.Invite, { send: input.send }),
  );

export const useDirectoryImport = () => useAdminAction(() => post("/admin/directory/sync", S.DirectoryImport));

export const useAssignHeld = () =>
  useAdminAction((input: { messageId: string; email: string }) =>
    post(`/admin/held/${input.messageId}/assign`, S.Done, { email: input.email }),
  );
