import type { MigrationBuilder } from "node-pg-migrate";

/**
 * Display settings follow-up: the admin-selected date format for generic
 * dashboard timestamps. Kept as an explicit pattern string so the stored
 * value does not depend on the browser locale.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns("app_settings", {
    default_date_format: {
      type: "text",
      notNull: true,
      default: "DD/MM/YYYY",
      comment: "Display date format for dashboard timestamps",
    },
  });
  pgm.addConstraint("app_settings", "app_settings_default_date_format_check", {
    check:
      "default_date_format IN ('DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY')",
  });
}

/** Drops the date-format column; the time zone setting is unaffected. */
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("app_settings", "app_settings_default_date_format_check");
  pgm.dropColumns("app_settings", ["default_date_format"]);
}
