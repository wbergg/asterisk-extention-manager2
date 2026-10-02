import { ref } from "vue";

import { api, ApiError, setViewAs, viewingAs, type Identity } from "./api";

/**
 * Who is signed in.
 *
 * Loaded once at boot. Access has already authenticated the browser by the
 * time any of this runs, so the only interesting outcomes are "provisioned"
 * (has a row in app_user) and "authenticated but unknown to us".
 */
export const identity = ref<Identity | null>(null);
export const identityError = ref<string | null>(null);
export const booted = ref(false);

/**
 * Whose screen is being shown, when it is not our own.
 *
 * `identity.impersonatedBy` is the authoritative answer once identity has
 * loaded; this is the request-level intent, which is what survives a reload
 * and what has to be cleared if the server refuses it.
 */
export const viewAs = ref<string | null>(viewingAs());

function clearViewAs(): void {
  setViewAs(null);
  viewAs.value = null;
}

export async function loadIdentity(retry = true): Promise<void> {
  try {
    identity.value = await api.me();
  } catch (e) {
    // A "view as" the server refuses (the admin's own role was revoked
    // mid-session, or the stored value is junk) would otherwise strand the app
    // on the not-signed-in panel — with the only control that clears it
    // unrendered. Drop it and load our own identity instead.
    if (
      retry &&
      viewAs.value &&
      e instanceof ApiError &&
      (e.status === 403 || e.status === 400)
    ) {
      clearViewAs();
      return loadIdentity(false);
    }
    identityError.value =
      e instanceof ApiError && e.status === 401
        ? "Your Cloudflare Access session has expired. Reload to sign in again."
        : e instanceof Error
          ? e.message
          : String(e);
  } finally {
    booted.value = true;
  }
}

export const isAdmin = () => identity.value?.role === "admin";

/**
 * Enter or leave "view as" with a full reload rather than a re-render.
 *
 * Role decides the nav, the router guard, and what every mounted view has
 * already fetched. Remounting the app is the only way to be sure nothing on
 * screen is left over from the previous identity — and landing on `/` avoids
 * sitting on an admin route the impersonated user cannot load.
 */
export function startViewAs(email: string): void {
  setViewAs(email.trim().toLowerCase());
  location.assign("/");
}

export function stopViewAs(): void {
  clearViewAs();
  location.assign("/");
}

/** An authenticated user with no delegated range can't create anything. */
export const hasRange = () =>
  identity.value?.role === "admin" ||
  (identity.value?.minExt !== null && identity.value?.maxExt !== null);

/** Transient toast messages. */
export interface Toast {
  id: number;
  kind: "ok" | "bad";
  text: string;
  /** Shown in a monospace block and never auto-dismissed — for secrets. */
  sticky?: string;
}

export const toasts = ref<Toast[]>([]);
let toastSeq = 0;

export function notify(
  kind: Toast["kind"],
  text: string,
  sticky?: string,
): void {
  const id = ++toastSeq;
  toasts.value.push({ id, kind, text, ...(sticky ? { sticky } : {}) });
  // A secret is shown exactly once and must not vanish before it is copied.
  if (!sticky) {
    setTimeout(() => dismiss(id), 5000);
  }
}

export function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
