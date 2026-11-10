"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { DateFormat } from "@summarly/contracts";
import { api } from "@/lib/api";
import { useResource } from "@/lib/hooks";
import { DEFAULT_DATE_FORMAT } from "@/lib/time";

/**
 * Global display settings for the dashboard. The time zone follows
 * Settings → Default time zone; the date format follows Settings →
 * Default date format. Group-specific screens can still pass their own
 * zone explicitly (e.g. a group's chat view).
 */
const TimeZoneContext = createContext<string>("UTC");
const DateFormatContext = createContext<DateFormat>(DEFAULT_DATE_FORMAT);

export function useAppTimeZone(): string {
  return useContext(TimeZoneContext);
}

export function useAppDateFormat(): DateFormat {
  return useContext(DateFormatContext);
}

export function TimeZoneProvider({ children }: { children: ReactNode }) {
  const settings = useResource(() => api.defaultTimezone(), []);
  const dateFormatSettings = useResource(() => api.defaultDateFormat(), []);
  const reloadTimezone = settings.reload;
  const reloadDateFormat = dateFormatSettings.reload;

  // The Settings screen announces a saved value so the whole app re-renders
  // with the new display setting immediately.
  useEffect(() => {
    const handler = (): void => reloadTimezone();
    window.addEventListener("summarly:timezone-changed", handler);
    return () => window.removeEventListener("summarly:timezone-changed", handler);
  }, [reloadTimezone]);

  useEffect(() => {
    const handler = (): void => reloadDateFormat();
    window.addEventListener("summarly:date-format-changed", handler);
    return () =>
      window.removeEventListener("summarly:date-format-changed", handler);
  }, [reloadDateFormat]);

  // "UTC" / DD/MM/YYYY are stable fallbacks while loading or if a setting
  // is unavailable; the provider re-renders once the real values arrive.
  const timeZone = settings.data?.timezone ?? "UTC";
  const dateFormat = dateFormatSettings.data?.dateFormat ?? DEFAULT_DATE_FORMAT;
  return (
    <TimeZoneContext.Provider value={timeZone}>
      <DateFormatContext.Provider value={dateFormat}>
        {children}
      </DateFormatContext.Provider>
    </TimeZoneContext.Provider>
  );
}
