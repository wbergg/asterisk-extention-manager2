import { ref } from "vue";

export type Theme = "dark" | "light";

/**
 * Where the choice is remembered.
 *
 * `index.html` reads this same key before first paint to avoid a flash of the
 * wrong theme — keep the key and the "dark unless light" default in step with
 * the boot script there.
 */
const KEY = "aem.theme";

/** The palette in effect. Dark is the default; light is opt-in. */
export const theme = ref<Theme>(read() ?? "dark");

function read(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    // Blocked site data (private window, locked-down browser). Not worth
    // surfacing — the default theme still renders.
    return null;
  }
}

/**
 * Point the document at a theme.
 *
 * Every colour in the GUI resolves through the `--aem-*` variables that
 * `style.css` hangs off this attribute, so this one write repaints the whole
 * app. Unlike "view as", it deliberately outlives the tab: a theme is a
 * preference, not a session.
 */
export function setTheme(next: Theme): void {
  theme.value = next;
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // The theme just will not survive a reload.
  }
}

/**
 * Re-assert the stored theme onto the document.
 *
 * The boot script has normally done this already; this covers the case where
 * it did not run (a host that strips inline scripts) and keeps the attribute
 * honest if it was never set.
 */
export function initTheme(): void {
  document.documentElement.dataset.theme = theme.value;
}
