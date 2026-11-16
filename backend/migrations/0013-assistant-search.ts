import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Assistant message search (MVP dashboard assistant).
 *
 * The assistant's `search_messages` intent answers "when did X talk
 * about Y" over captured messages. Two matching paths are involved:
 *
 * - Substring search (`m.body ILIKE '%query%'`) — the trigram GIN index
 *   below makes ILIKE with a leading wildcard index-supported instead of
 *   a sequential scan.
 * - Fuzzy search (`similarity(m.body, query) > 0.15`) — requires the
 *   `pg_trgm` extension. The `similarity()` FUNCTION is not index-backed
 *   (only the `%` operator is), so this predicate is evaluated per
 *   candidate row. At MVP scale (one small self-hosted install) that is
 *   acceptable; if message volume ever makes it slow, switch the
 *   predicate to `m.body % query` with a tuned
 *   `pg_trgm.similarity_threshold`, which the same index serves.
 *
 * Both are read-only, authenticated-admin queries over messages from
 * MONITORED groups only (the SQL joins `groups.monitored = true`), so
 * the index does not change the privacy boundary.
 *
 * `pg_trgm` ships with PostgreSQL as a trusted extension; managed
 * providers normally allow it. If the operator's database forbids
 * `CREATE EXTENSION`, the migration fails loudly rather than leaving
 * search silently slow/broken.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  pgm.sql(
    `CREATE INDEX IF NOT EXISTS messages_body_trgm_idx
       ON messages USING gin (body gin_trgm_ops)`,
  );
}

/**
 * Drops only the index. The extension is deliberately left in place:
 * other future indexes/queries may use it, and removing an extension
 * can fail when unrelated objects depend on it. Dropping it here would
 * also make a later `up` require superuser-ish rights again.
 */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql("DROP INDEX IF EXISTS messages_body_trgm_idx");
}
