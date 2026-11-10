"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { api, toApiError } from "@/lib/api";
import { errorMessage } from "@/lib/messages";
import { NotificationProvider } from "./notifications/NotificationProvider";
import { TimeZoneProvider } from "./TimeZoneProvider";
import { Button } from "./ui/Button";

type IconName =
  | "overview"
  | "groups"
  | "contacts"
  | "runs"
  | "connection"
  | "settings"
  | "menu"
  | "close"
  | "logout";

const ICON_PATHS: Record<IconName, ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.6" />
      <rect x="14" y="3" width="7" height="7" rx="1.6" />
      <rect x="3" y="14" width="7" height="7" rx="1.6" />
      <rect x="14" y="14" width="7" height="7" rx="1.6" />
    </>
  ),
  groups: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.6a3 3 0 0 1 0 5.8" />
      <path d="M17.6 19a5.4 5.4 0 0 0-2-4.2" />
    </>
  ),
  runs: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </>
  ),
  contacts: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <circle cx="17.5" cy="9" r="2.5" />
      <path d="M14.8 18.5a4.5 4.5 0 0 1 6.7-3.9" />
    </>
  ),
  connection: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.4" />
      <rect x="14" y="3" width="7" height="7" rx="1.4" />
      <rect x="3" y="14" width="7" height="7" rx="1.4" />
      <path d="M14 14h3v3h-3zM20.2 14v.01M14 20.2v.01M20.2 20.2v.01" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M18 7h2M4 17h2M10 17h10" />
      <circle cx="15.5" cy="7" r="2.2" />
      <circle cx="8" cy="17" r="2.2" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  logout: (
    <>
      <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 16l4-4-4-4M14 12H3" />
    </>
  ),
};

function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`h-[18px] w-[18px] shrink-0 ${className}`}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Overview", icon: "overview" },
  { href: "/groups", label: "Groups", icon: "groups" },
  { href: "/contacts", label: "Contacts", icon: "contacts" },
  { href: "/runs", label: "Summary runs", icon: "runs" },
  { href: "/connection", label: "Connection", icon: "connection" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="leading-tight">
      <p className="text-sm font-semibold text-slate-900">Summarly</p>
      {compact ? null : (
        <p className="text-xs text-slate-500">WhatsApp group summaries</p>
      )}
    </div>
  );
}

interface NavListProps {
  pathname: string;
  onNavigate?: () => void;
  /** Desktop rail: labels are hidden until the sidebar is hovered/focused. */
  hoverExpand?: boolean;
}

function NavList({
  pathname,
  onNavigate,
  hoverExpand = false,
}: NavListProps) {
  return (
    <nav aria-label="Primary">
      <ul className="space-y-1">
        {NAV_ITEMS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                title={item.label}
                onClick={onNavigate}
                className={`flex items-center rounded-lg text-sm font-medium transition-all duration-200 ${
                  hoverExpand
                    ? "justify-center gap-0 px-2 py-2.5 group-hover:justify-start group-hover:gap-3 group-hover:px-3 group-focus-within:justify-start group-focus-within:gap-3 group-focus-within:px-3"
                    : "gap-3 px-3 py-2"
                } ${
                  active
                    ? "bg-brand-50 text-brand-800"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <Icon
                  name={item.icon}
                  className={active ? "text-brand-600" : "text-slate-400"}
                />
                <span
                  className={
                    hoverExpand
                      ? "max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,opacity] duration-200 group-hover:max-w-[12rem] group-hover:opacity-100 group-focus-within:max-w-[12rem] group-focus-within:opacity-100"
                      : "whitespace-nowrap"
                  }
                >
                  {item.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

interface SignOutButtonProps {
  loading: boolean;
  onClick: () => void;
  className?: string;
  /** Desktop rail: text is hidden until the sidebar is hovered/focused. */
  hoverExpand?: boolean;
}

function SignOutButton({
  loading,
  onClick,
  className = "",
  hoverExpand = false,
}: SignOutButtonProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={loading}
      onClick={onClick}
      title="Sign out"
      className={`w-full text-slate-600 transition-all duration-200 ${
        hoverExpand
          ? "justify-center gap-0 px-2 group-hover:justify-start group-hover:gap-3 group-hover:px-3 group-focus-within:justify-start group-focus-within:gap-3 group-focus-within:px-3"
          : "justify-start gap-3"
      } ${className}`}
    >
      {loading ? null : <Icon name="logout" className="text-slate-400" />}
      <span
        className={
          hoverExpand
            ? "max-w-0 overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,opacity] duration-200 group-hover:max-w-[12rem] group-hover:opacity-100 group-focus-within:max-w-[12rem] group-focus-within:opacity-100"
            : "whitespace-nowrap"
        }
      >
        Sign out
      </span>
    </Button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const drawerRef = useRef<HTMLDialogElement | null>(null) as RefObject<
    HTMLDialogElement | null
  >;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [suppressHover, setSuppressHover] = useState(false);

  /**
   * A nav click collapses the desktop rail immediately, even while the
   * pointer is still over it. Moving the pointer out resets the flag, so
   * the next hover expands normally.
   */
  function handleNavigate(): void {
    setSuppressHover(true);
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    const drawer = drawerRef.current;
    if (drawer !== null && drawer.open) drawer.close();
  }, [pathname]);

  function openDrawer(): void {
    const drawer = drawerRef.current;
    if (drawer === null) return;
    setDrawerOpen(true);
    drawer.showModal();
  }

  async function handleLogout(): Promise<void> {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await api.logout();
      router.replace("/login");
      router.refresh();
    } catch (cause) {
      setLogoutError(errorMessage(toApiError(cause)));
      setLoggingOut(false);
    }
  }

  return (
    <NotificationProvider>
      <TimeZoneProvider>
        <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-brand-700 focus:shadow-raised"
      >
        Skip to main content
      </a>

      {/* Desktop sidebar: icon rail, expands on hover/focus with an overlay */}
      <aside
        className={`${
          suppressHover ? "" : "group"
        } fixed inset-y-0 left-0 z-30 hidden w-[4.5rem] flex-col overflow-hidden border-r border-slate-200 bg-white shadow-sm transition-[width,box-shadow] duration-200 ease-out lg:flex ${
          suppressHover
            ? ""
            : "hover:w-64 hover:shadow-raised focus-within:w-64 focus-within:shadow-raised"
        }`}
        onMouseLeave={() => setSuppressHover(false)}
        onFocusCapture={() => setSuppressHover(false)}
      >
        <div className="flex h-16 shrink-0 items-center overflow-hidden px-4">
          <Link
            href="/"
            aria-label="Summarly home"
            onClick={handleNavigate}
            className="flex w-full items-center rounded-lg"
          >
            <span className="max-w-0 overflow-hidden whitespace-nowrap text-sm font-semibold text-slate-900 opacity-0 transition-[max-width,opacity] duration-200 group-hover:max-w-[12rem] group-hover:opacity-100 group-focus-within:max-w-[12rem] group-focus-within:opacity-100">
              Summarly
            </span>
          </Link>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-4 transition-[padding] duration-200 group-hover:px-3 group-focus-within:px-3">
          <NavList pathname={pathname} hoverExpand onNavigate={handleNavigate} />
        </div>
        <div className="border-t border-slate-200 px-2 py-3 transition-[padding] duration-200 group-hover:px-3 group-focus-within:px-3">
          <SignOutButton
            loading={loggingOut}
            onClick={() => void handleLogout()}
            hoverExpand
          />
          <p className="mt-2 max-h-0 overflow-hidden whitespace-nowrap px-3 text-[11px] leading-4 text-slate-400 opacity-0 transition-[max-height,opacity] duration-200 group-hover:max-h-8 group-hover:opacity-100 group-focus-within:max-h-8 group-focus-within:opacity-100">
            Self-hosted · administrator
          </p>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="flex min-w-0 flex-col lg:pl-[4.5rem]">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={openDrawer}
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            aria-haspopup="dialog"
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-100"
          >
            <Icon name="menu" className="h-5 w-5" />
          </button>
          <Brand compact />
          <span className="h-10 w-10" aria-hidden="true" />
        </header>

        <main
          id="main"
          className="mx-auto w-full max-w-6xl scroll-mt-24 px-4 py-6 sm:px-6 lg:scroll-mt-8 lg:px-8 lg:py-10"
        >
          {children}
        </main>
      </div>

      {/* Mobile drawer (native dialog: focus trap, Escape, backdrop) */}
      <dialog
        ref={drawerRef}
        aria-label="Navigation"
        onClose={() => setDrawerOpen(false)}
        className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-72 max-w-[85vw] rounded-none border-0 p-0 text-slate-900 shadow-raised backdrop:bg-slate-900/40"
      >
        <div className="flex h-full flex-col bg-white">
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-4">
            <Brand />
            <button
              type="button"
              onClick={() => drawerRef.current?.close()}
              aria-label="Close navigation"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
            >
              <Icon name="close" className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-4">
            <NavList
              pathname={pathname}
              onNavigate={() => drawerRef.current?.close()}
            />
          </div>
          <div className="border-t border-slate-200 px-3 py-3">
            <SignOutButton
              loading={loggingOut}
              onClick={() => void handleLogout()}
            />
            {logoutError === null || !drawerOpen ? null : (
              <p role="alert" className="mt-2 px-3 text-xs font-medium text-red-700">
                {logoutError}
              </p>
            )}
          </div>
        </div>
      </dialog>

      {logoutError === null || drawerOpen ? null : (
        <div
          role="alert"
          className="fixed bottom-4 left-4 right-4 z-40 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-800 shadow-raised lg:left-[5.5rem] lg:right-auto lg:max-w-md"
        >
          Could not sign out: {logoutError}
        </div>
      )}
        </div>
      </TimeZoneProvider>
    </NotificationProvider>
  );
}
