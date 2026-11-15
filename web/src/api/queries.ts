import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiFailure, get, post } from "./client";
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

/** A folder's messages, newest first, refreshed every 30 seconds so new mail shows up unprompted. */
export function useFolder(folder: S.Folder) {
  return useInfiniteQuery({
    queryKey: ["messages", folder],
    queryFn: ({ pageParam }) =>
      get(`/messages?folder=${folder}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, S.MessageList),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
}

/** One message with its body. Opening it marks it read, so the folder lists are refreshed. */
export function useMessage(id: string | null) {
  const client = useQueryClient();

  return useQuery({
    queryKey: ["message", id],
    enabled: id !== null,
    queryFn: async () => {
      const { message } = await get(`/messages/${id}`, S.MessageEnvelope);

      void client.invalidateQueries({ queryKey: ["messages"] });

      return message;
    },
    staleTime: 60_000,
  });
}

export interface Draft {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  inReplyToId?: string;
  attachments: { filename: string; contentType: string; contentBase64: string }[];
}

export function useSendMessage() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (draft: Draft) => post("/messages", S.Sent, draft),
    onSuccess: () => client.invalidateQueries({ queryKey: ["messages", "sent"] }),
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
