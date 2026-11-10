"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useResource } from "@/lib/hooks";

/**
 * Global display time zone for the dashboard. It follows the admin's
 * Settings → Default time zone value; group-specific screens can still
 * pass their own zone explicitly (e.g. a group's chat view).
 */
const TimeZoneContext = createContext<string>("UTC");

export function useAppTimeZone(): string {
  return useContext(TimeZoneContext);
}

export function TimeZoneProvider({ children }: { children: ReactNode }) {
  const settings = useResource(() => api.defaultTimezone(), []);
  const reload = settings.reload;
  // The Settings screen announces a saved default zone so the whole app
  // re-renders with the new display time zone immediately.
  useEffect(() => {
    const handler = (): void => reload();
    window.addEventListener("summarly:timezone-changed", handler);
    return () => window.removeEventListener("summarly:timezone-changed", handler);
  }, [reload]);
  // "UTC" is the stable fallback while loading or if the setting is
  // unavailable; the provider re-renders once the real value arrives.
  const timeZone = settings.data?.timezone ?? "UTC";
  return (
    <TimeZoneContext.Provider value={timeZone}>
      {children}
    </TimeZoneContext.Provider>
  );
}
