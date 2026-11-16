import type { FastifyInstance } from "fastify";
import {
  ApiMessagePage,
  Group,
  GroupMember,
  Id,
  IsoDateTime,
  UpdateGroupRequest,
} from "@summarly/contracts";
import { z } from "zod";
import { HttpError } from "../lib/errors.js";
import {
  decodeMessageCursor,
  encodeMessageCursor,
  type Store,
} from "../lib/store.js";

const GroupParams = z.object({ id: Id });

/** Messages query (ADR 0008): optional half-open date range + paging. */
const MessagesQuery = z.object({
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(400).optional(),
});

const SummariesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const DEFAULT_MESSAGES_LIMIT = 50;
const DEFAULT_SUMMARIES_LIMIT = 20;

export function registerGroupRoutes(
  app: FastifyInstance,
  store: Store,
): void {
  app.get("/api/groups", async () => store.listGroups());

  /** Single group (the group detail screen). */
  app.get("/api/groups/:id", async (request) => {
    const { id } = GroupParams.parse(request.params);
    const group = await store.getGroup(id);
    if (group === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    return group;
  });

  /**
   * Members of the group's chat (ADR 0008): best-effort roster
   * snapshots maintained by the bot-worker. Names/JIDs are PII — this
   * is the authenticated API, the same one that already serves
   * messages. MONITORED GROUPS ONLY (fix round B, audit H-1): a roster
   * is only ever collected for a group the admin opted in, so only a
   * monitored group can serve one — same privacy boundary and same 409
   * style as the history import below.
   */
  app.get("/api/groups/:id/members", async (request) => {
    const { id } = GroupParams.parse(request.params);
    const group = await store.getGroup(id);
    if (group === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    if (!group.monitored) {
      throw new HttpError(409, "conflict", "Group is not monitored.");
    }
    if (group.chatId === null) {
      // No discovered chat yet: an empty roster, not an error.
      return [] satisfies GroupMember[];
    }
    return store.listGroupMembers(group.chatId);
  });

  /**
   * Chat history as a paginated, newest-first message list (ADR 0008).
   * The dashboard renders it like a chat; `from`/`to` filter the
   * half-open instant range [from, to). `cursor` is the previous
   * page's `nextCursor`. The envelope is `ApiMessagePage`.
   */
  app.get("/api/groups/:id/messages", async (request) => {
    const { id } = GroupParams.parse(request.params);
    const query = MessagesQuery.parse(request.query);
    const group = await store.getGroup(id);
    if (group === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    if (
      query.from !== undefined &&
      query.to !== undefined &&
      Date.parse(query.from) >= Date.parse(query.to)
    ) {
      throw new HttpError(
        400,
        "validation_error",
        "Invalid range: `from` must be an instant before `to`.",
      );
    }
    if (query.cursor !== undefined && decodeMessageCursor(query.cursor) === undefined) {
      throw new HttpError(400, "validation_error", "Invalid cursor.");
    }
    if (group.chatId === null) {
      return { items: [], nextCursor: null } satisfies ApiMessagePage;
    }
    const limit = query.limit ?? DEFAULT_MESSAGES_LIMIT;
    // Fetch one extra row (fix round A, m1): `nextCursor` must be
    // emitted ONLY when another page truly exists — an exact-multiple
    // page size must not produce a dangling cursor that resolves to an
    // empty page.
    const fetched = await store.listGroupMessages(group.chatId, {
      from: query.from,
      to: query.to,
      limit: limit + 1,
      cursor: query.cursor,
    });
    const items = fetched.slice(0, limit);
    const hasMore = fetched.length > limit;
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last !== undefined
          ? encodeMessageCursor({ sentAt: last.sentAt, id: last.id })
          : null,
    } satisfies ApiMessagePage;
  });

  /** Past summaries of the group, newest first (period + provider/model). */
  app.get("/api/groups/:id/summaries", async (request) => {
    const { id } = GroupParams.parse(request.params);
    const query = SummariesQuery.parse(request.query);
    const group = await store.getGroup(id);
    if (group === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    // Summaries join by GROUP id (runs belong to groups): a group with
    // no discovered chat can still have scheduled runs.
    return store.listGroupSummaries(id, {
      limit: query.limit ?? DEFAULT_SUMMARIES_LIMIT,
    });
  });

  app.patch("/api/groups/:id", async (request) => {
    const { id } = GroupParams.parse(request.params);
    const body = UpdateGroupRequest.parse(request.body);
    const group = await store.getGroup(id);
    if (group === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    // SA-M1 (consent): un-monitoring revokes a PENDING history import —
    // the old request must never fire later just because the group is
    // monitored again. Cancel BEFORE the update so the response carries
    // the cleared state. `running` imports are not touched (the
    // bot-worker aborts those itself).
    const unmonitoring = group.monitored && body.monitored === false;
    if (unmonitoring) {
      await store.cancelPendingHistoryImport(id);
    }
    // summaryTime distinguishes "absent" (keep) from explicit null (clear).
    // chatId is read-only metadata; PATCH never changes it. historyImport
    // is system-managed (ADR 0007) and is carried over untouched — the
    // store preserves it even if a caller tampers with this literal.
    const updated: Group = {
      id: group.id,
      chatId: group.chatId,
      name: group.name,
      monitored: body.monitored ?? group.monitored,
      timezone: body.timezone ?? group.timezone,
      summaryTime:
        body.summaryTime !== undefined ? body.summaryTime : group.summaryTime,
      historyImport: group.historyImport,
    };
    const stored = await store.updateGroup(updated);
    if (stored === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    // Monitoring enabled (unmonitored -> monitored): ask the bot-worker
    // for a roster refresh. Discovery only syncs monitored chats, so a
    // group discovered before the admin opted in has no roster — without
    // this request the Members tab stays empty until a membership event
    // (migration 0016). Best-effort: the group update already committed,
    // so a failed request write must never turn the PATCH into an error
    // (the admin can retry via POST /api/groups/:id/roster-sync).
    if (!group.monitored && stored.monitored) {
      try {
        await store.requestGroupRosterSync(stored.id);
      } catch (error) {
        request.log.warn(
          {
            groupId: stored.id,
            reason: error instanceof Error ? error.name : "unknown",
          },
          "failed to request roster sync after enabling monitoring",
        );
      }
    }
    return stored;
  });

  /**
   * Requests a WhatsApp history import for the group (ADR 0007). The
   * dashboard asks the admin this question when a group is switched to
   * monitored; the actual import is performed later by the bot-worker,
   * which polls the system-managed historyImport state.
   *
   * - 404 unknown group;
   * - 409 when the group is NOT monitored (imports are only ever done
   *   for monitored groups — the privacy boundary of ADR 0004);
   * - 200 with the current Group when an import is already
   *   pending/running (idempotent);
   * - 202 with the updated Group when a new request is accepted
   *   (including re-requests after done/failed).
   */
  app.post("/api/groups/:id/history-import", async (request, reply) => {
    const { id } = GroupParams.parse(request.params);
    const group = await store.getGroup(id);
    if (group === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    if (!group.monitored) {
      throw new HttpError(
        409,
        "conflict",
        "Group must be monitored before importing history.",
      );
    }
    const result = await store.requestHistoryImport(id);
    if (result === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    // The response code is derived from the WRITE (`changed`), not from
    // a pre-write read: concurrent requests cannot both answer 202
    // (review CR-m1). 202 = this call performed the transition; 200 =
    // an import was already in flight.
    return reply.status(result.changed ? 202 : 200).send(result.group);
  });

  /**
   * Requests an on-demand roster sync for the group (migration 0016):
   * the manual "refresh members" path behind the Members tab. The
   * backend only records the request; the bot-worker's session-control
   * poll claims it, fetches the group metadata from WhatsApp and syncs
   * `group_members`. Best-effort by construction — the roster can still
   * come back empty (metadata unavailable), which is why the endpoint
   * answers 202 rather than a roster.
   *
   * - 404 unknown group;
   * - 409 when the group is NOT monitored (rosters are monitored-only,
   *   the same privacy boundary as the history import);
   * - 202 `{ "ok": true }` when the request was recorded. Idempotent:
   *   repeated requests collapse into one pending flag.
   */
  app.post("/api/groups/:id/roster-sync", async (request, reply) => {
    const { id } = GroupParams.parse(request.params);
    const group = await store.getGroup(id);
    if (group === undefined) {
      throw new HttpError(404, "not_found", "Group not found.");
    }
    if (!group.monitored) {
      throw new HttpError(
        409,
        "conflict",
        "Group must be monitored before syncing its roster.",
      );
    }
    await store.requestGroupRosterSync(id);
    return reply.status(202).send({ ok: true });
  });
}
