import type {
  ApiMessagePage,
  ConnectionStatus,
  ContactDetail,
  ContactMessagePage,
  ContactSummary,
  CreateAdminRequest,
  CreateAdminResponse,
  CreateRunRequest,
  DefaultTimezoneSettings,
  ErrorCode,
  ErrorDetail,
  Group,
  GroupMember,
  GroupSummary,
  LoginRequest,
  OkResponse,
  ProviderConfigPublic,
  ProviderConfigUpdate,
  RecoverRequest,
  RenameContactRequest,
  RunListResponse,
  SetupStatus,
  Summary,
  SummaryRun,
  UpdateGroupRequest,
} from "@summarly/contracts";

/**
 * Single access point for the backend API.
 *
 * Rules enforced here (architecture §4.1, docs/api.md):
 * - relative `/api/...` URLs only, so the browser stays same-origin and the
 *   httpOnly session cookie is sent (`credentials: "include"`);
 * - the standard error envelope is always parsed into `ApiError`;
 * - a `401` redirects to `/login` (never from the auth screens);
 * - a request that never reached the backend is reported as `code: "network"`.
 */

/** `ErrorCode` from the contract plus the client-only "network" failure. */
export type ApiErrorCode = ErrorCode | "network";

export class ApiError extends Error {
  readonly status: number | null;
  readonly code: ApiErrorCode;
  readonly details: ErrorDetail[];

  constructor(init: {
    status: number | null;
    code: ApiErrorCode;
    message: string;
    details?: ErrorDetail[];
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? [];
  }
}

/** Screens where an unauthorized response must not cause a redirect loop. */
const AUTH_SCREENS = ["/login", "/recover", "/setup"];

const REQUEST_TIMEOUT_MS = 20_000;

const FALLBACK_MESSAGES: Record<ApiErrorCode, string> = {
  validation_error: "The request was rejected. Check the highlighted fields.",
  unauthorized: "Authentication required.",
  forbidden: "You are not allowed to perform this action.",
  not_found: "The requested resource was not found.",
  conflict: "The request conflicts with the current state.",
  rate_limited: "Too many attempts — try again later.",
  internal: "The backend reported an internal error.",
  network: "Cannot reach the Summarly backend.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "internal";
  return "validation_error";
}

function toErrorDetail(value: unknown): ErrorDetail | null {
  if (!isRecord(value)) return null;
  const { path, message } = value;
  if (typeof path !== "string" || typeof message !== "string") return null;
  return { path, message };
}

function errorFromResponse(status: number, payload: unknown): ApiError {
  const fallbackCode = codeForStatus(status);

  if (isRecord(payload) && isRecord(payload.error)) {
    const { code, message, details } = payload.error;
    const resolvedCode: ApiErrorCode =
      typeof code === "string" && code in FALLBACK_MESSAGES
        ? (code as ApiErrorCode)
        : fallbackCode;
    return new ApiError({
      status,
      code: resolvedCode,
      message:
        typeof message === "string" && message.trim().length > 0
          ? message
          : FALLBACK_MESSAGES[resolvedCode],
      details: Array.isArray(details)
        ? details.flatMap((detail) => {
            const parsed = toErrorDetail(detail);
            return parsed === null ? [] : [parsed];
          })
        : [],
    });
  }

  return new ApiError({
    status,
    code: fallbackCode,
    message:
      status >= 500 && payload === null
        ? "The Summarly backend did not return a valid API response. Check that the backend service is running."
        : FALLBACK_MESSAGES[fallbackCode],
  });
}

function networkError(cause: unknown): ApiError {
  const timedOut =
    cause instanceof DOMException &&
    (cause.name === "TimeoutError" || cause.name === "AbortError");
  return new ApiError({
    status: null,
    code: "network",
    message: timedOut
      ? "The Summarly backend did not respond in time. Check that it is running and try again."
      : "Cannot reach the Summarly backend. Check that the backend service is running and that BACKEND_URL is correct.",
  });
}

/**
 * The parts of `window.location` this module needs. Keeping the shape narrow
 * lets unit tests exercise the redirect rule without a DOM.
 */
export interface BrowserLocation {
  readonly pathname: string;
  assign(path: string): void;
}

let locationOverride: BrowserLocation | null = null;

/**
 * Test seam (see `dashboard/tests/api.test.ts`). Production code never calls
 * this; `null` restores the real `window.location` lookup.
 */
export function setBrowserLocationForTests(location: BrowserLocation | null): void {
  locationOverride = location;
}

function currentLocation(): BrowserLocation | null {
  if (locationOverride !== null) return locationOverride;
  if (typeof window === "undefined") return null;
  return window.location;
}

function redirectToLoginIfUnauthorized(status: number): void {
  if (status !== 401) return;
  const location = currentLocation();
  if (location === null) return;
  const { pathname } = location;
  const onAuthScreen = AUTH_SCREENS.some(
    (screen) => pathname === screen || pathname.startsWith(`${screen}/`),
  );
  if (onAuthScreen) return;
  location.assign("/login");
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH";
  body?: unknown;
}

async function requestRaw<T>(
  path: string,
  options: RequestOptions = {},
): Promise<{ data: T; status: number }> {
  const { method = "GET", body } = options;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: "include",
      cache: "no-store",
      headers:
        body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw networkError(cause);
  }

  const text = await response.text().catch(() => "");
  const payload: unknown = text.length > 0 ? parseJson(text) : null;

  if (!response.ok) {
    redirectToLoginIfUnauthorized(response.status);
    throw errorFromResponse(response.status, payload);
  }

  return { data: payload as T, status: response.status };
}

/** Normalizes anything thrown during a request into an `ApiError`. */
export function toApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  if (cause instanceof Error) {
    return new ApiError({
      status: null,
      code: "internal",
      message: cause.message,
    });
  }
  return new ApiError({
    status: null,
    code: "internal",
    message: "Unexpected error. Please try again.",
  });
}

export function isNetworkError(cause: unknown): boolean {
  return cause instanceof ApiError && cause.code === "network";
}

/**
 * Query for `GET /api/groups/:id/messages`; the response envelope is the
 * shared contract type `ApiMessagePage` (newest first, `nextCursor`).
 */
export interface GroupMessagesQuery {
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export const api = {
  setupStatus(): Promise<SetupStatus> {
    return requestRaw<SetupStatus>("/setup/status").then((result) => result.data);
  },

  createAdmin(body: CreateAdminRequest): Promise<CreateAdminResponse> {
    return requestRaw<CreateAdminResponse>("/setup", {
      method: "POST",
      body,
    }).then((result) => result.data);
  },

  login(body: LoginRequest): Promise<OkResponse> {
    return requestRaw<OkResponse>("/auth/login", {
      method: "POST",
      body,
    }).then((result) => result.data);
  },

  async logout(): Promise<OkResponse> {
    return (await requestRaw<OkResponse>("/auth/logout", { method: "POST" })).data;
  },

  recover(body: RecoverRequest): Promise<OkResponse> {
    return requestRaw<OkResponse>("/auth/recover", {
      method: "POST",
      body,
    }).then((result) => result.data);
  },

  connection(): Promise<ConnectionStatus> {
    return requestRaw<ConnectionStatus>("/connection").then(
      (result) => result.data,
    );
  },

  /**
   * Asks the bot worker to end the linked WhatsApp session (ADR 0008).
   * Idempotent: `202` whether or not a request was already pending.
   */
  async logoutConnection(): Promise<OkResponse> {
    return (
      await requestRaw<OkResponse>("/connection/logout", { method: "POST" })
    ).data;
  },

  /**
   * Requests a live WhatsApp session health check. The bot worker performs
   * the probe; poll `connection()` for the pending/ok/failed result.
   */
  async testConnection(): Promise<OkResponse> {
    return (
      await requestRaw<OkResponse>("/connection/test", { method: "POST" })
    ).data;
  },

  groups(): Promise<Group[]> {
    return requestRaw<Group[]>("/groups").then((result) => result.data);
  },

  /** A single group (the group detail screen). */
  group(id: string): Promise<Group> {
    return requestRaw<Group>(`/groups/${encodeURIComponent(id)}`).then(
      (result) => result.data,
    );
  },

  /** Best-effort roster snapshot of the group's chat (ADR 0008). */
  groupMembers(id: string): Promise<GroupMember[]> {
    return requestRaw<GroupMember[]>(
      `/groups/${encodeURIComponent(id)}/members`,
    ).then((result) => result.data);
  },

  /**
   * Chat history, newest first, paginated by `nextCursor`. `from`/`to` are
   * instants filtering the half-open range `[from, to)`.
   */
  groupMessages(id: string, query: GroupMessagesQuery = {}): Promise<ApiMessagePage> {
    const params = new URLSearchParams();
    if (query.from !== undefined) params.set("from", query.from);
    if (query.to !== undefined) params.set("to", query.to);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    const search = params.toString();
    return requestRaw<ApiMessagePage>(
      `/groups/${encodeURIComponent(id)}/messages${search === "" ? "" : `?${search}`}`,
    ).then((result) => result.data);
  },

  /** Past summaries of the group, newest first, with their run interval. */
  groupSummaries(id: string): Promise<GroupSummary[]> {
    return requestRaw<GroupSummary[]>(
      `/groups/${encodeURIComponent(id)}/summaries`,
    ).then((result) => result.data);
  },

  /** Contacts observed in monitored groups (PII, authenticated admin). */
  contacts(): Promise<ContactSummary[]> {
    return requestRaw<ContactSummary[]>("/contacts").then(
      (result) => result.data,
    );
  },

  /** One contact with aliases and monitored-group memberships. */
  contact(id: string): Promise<ContactDetail> {
    return requestRaw<ContactDetail>(
      `/contacts/${encodeURIComponent(id)}`,
    ).then((result) => result.data);
  },

  /** Admin display-name override for a contact. */
  renameContact(
    id: string,
    body: RenameContactRequest,
  ): Promise<ContactDetail> {
    return requestRaw<ContactDetail>(
      `/contacts/${encodeURIComponent(id)}`,
      { method: "PATCH", body },
    ).then((result) => result.data);
  },

  /** Messages sent by a contact across monitored groups, newest first. */
  contactMessages(
    id: string,
    query: GroupMessagesQuery = {},
  ): Promise<ContactMessagePage> {
    const params = new URLSearchParams();
    if (query.from !== undefined) params.set("from", query.from);
    if (query.to !== undefined) params.set("to", query.to);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor !== undefined) params.set("cursor", query.cursor);
    const search = params.toString();
    return requestRaw<ContactMessagePage>(
      `/contacts/${encodeURIComponent(id)}/messages${search === "" ? "" : `?${search}`}`,
    ).then((result) => result.data);
  },

  updateGroup(id: string, body: UpdateGroupRequest): Promise<Group> {
    return requestRaw<Group>(`/groups/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
    }).then((result) => result.data);
  },

  /**
   * Requests a WhatsApp history import for a monitored group (ADR 0007).
   * `202` accepts a new (or repeat) request; `200` means an import is already
   * pending/running and the call was an idempotent no-op. `409` means the group
   * is not monitored; `404` an unknown group.
   */
  async requestHistoryImport(
    id: string,
  ): Promise<{ group: Group; accepted: boolean }> {
    const result = await requestRaw<Group>(
      `/groups/${encodeURIComponent(id)}/history-import`,
      { method: "POST" },
    );
    return { group: result.data, accepted: result.status === 202 };
  },

  runs(): Promise<RunListResponse> {
    return requestRaw<RunListResponse>("/summary-runs").then(
      (result) => result.data,
    );
  },

  run(id: string): Promise<SummaryRun> {
    return requestRaw<SummaryRun>(`/summary-runs/${encodeURIComponent(id)}`).then(
      (result) => result.data,
    );
  },

  /**
   * Create-or-find. `created` is false when the backend answered `200`, which
   * means an identical run already existed (`201` creates a new one).
   */
  async createRun(
    body: CreateRunRequest,
  ): Promise<{ run: SummaryRun; created: boolean }> {
    const result = await requestRaw<SummaryRun>("/summary-runs", {
      method: "POST",
      body,
    });
    return { run: result.data, created: result.status === 201 };
  },

  retryRun(id: string): Promise<SummaryRun> {
    return requestRaw<SummaryRun>(
      `/summary-runs/${encodeURIComponent(id)}/retry`,
      { method: "POST" },
    ).then((result) => result.data);
  },

  /**
   * Summary of a run, or `null` while no summary exists yet (`404`).
   *
   * Uses the run-scoped route `GET /api/summary-runs/:id/summary` (implemented
   * by the backend alongside the summary-id keyed `GET /api/summaries/:id`).
   * Both answer `404` when there is no summary, which this method maps to the
   * "not generated yet" state.
   */
  async runSummary(runId: string): Promise<Summary | null> {
    try {
      const result = await requestRaw<Summary>(
        `/summary-runs/${encodeURIComponent(runId)}/summary`,
      );
      return result.data;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) return null;
      throw cause;
    }
  },

  /** `null` when the provider is not configured yet (`404`). */
  async providerConfig(): Promise<ProviderConfigPublic | null> {
    try {
      const result = await requestRaw<ProviderConfigPublic>(
        "/settings/ai-provider",
      );
      return result.data;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) return null;
      throw cause;
    }
  },

  updateProvider(body: ProviderConfigUpdate): Promise<ProviderConfigPublic> {
    return requestRaw<ProviderConfigPublic>("/settings/ai-provider", {
      method: "PUT",
      body,
    }).then((result) => result.data);
  },

  /** Global default IANA zone for new groups / the summary form. */
  defaultTimezone(): Promise<DefaultTimezoneSettings> {
    return requestRaw<DefaultTimezoneSettings>(
      "/settings/default-timezone",
    ).then((result) => result.data);
  },

  updateDefaultTimezone(
    body: DefaultTimezoneSettings,
  ): Promise<DefaultTimezoneSettings> {
    return requestRaw<DefaultTimezoneSettings>("/settings/default-timezone", {
      method: "PUT",
      body,
    }).then((result) => result.data);
  },
};
