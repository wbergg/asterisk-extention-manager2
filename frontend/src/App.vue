<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";

import Btn from "./components/Btn.vue";
import ThemeToggle from "./components/ThemeToggle.vue";
import ViewAsDialog from "./components/ViewAsDialog.vue";
import {
  booted,
  dismiss,
  identity,
  identityError,
  isAdmin,
  stopViewAs,
  toasts,
} from "./state";

const route = useRoute();

/**
 * Set only while impersonating. Read off the identity the server returned
 * rather than off the stored intent, so the banner cannot claim a view the
 * requests are not actually getting.
 */
const viewingAs = computed(() => identity.value?.impersonatedBy ?? null);
const picking = ref(false);

/** What the impersonated user is, in a phrase: `user, 1000–1099`. */
const viewedPrivileges = computed(() => {
  const id = identity.value;
  if (!id) return "";
  return id.minExt !== null ? `${id.role}, ${id.minExt}–${id.maxExt}` : id.role;
});

const nav = computed(() => {
  const items = [
    { to: "/", label: "PBXes", admin: false },
    { to: "/extensions", label: "Extensions", admin: false },
    { to: "/directory", label: "Directory", admin: false },
    { to: "/calls", label: "Call log", admin: false },
  ];
  const adminItems = [
    { to: "/devices", label: "SCCP devices", admin: true },
    { to: "/admin/users", label: "Users", admin: true },
    { to: "/admin/blocked", label: "Blocked", admin: true },
    { to: "/admin/profiles", label: "Profiles", admin: true },
    { to: "/admin/audit", label: "Audit", admin: true },
  ];
  return { items, adminItems: isAdmin() ? adminItems : [] };
});

const linkCls = (to: string) => {
  const active =
    to === "/" ? route.path === "/" : route.path.startsWith(to);
  return active
    ? "border-l-2 border-accent-400 bg-panel-850 pl-[14px] text-ink-100"
    : "border-l-2 border-transparent pl-[14px] text-ink-300 hover:bg-panel-850/60 hover:text-ink-100";
};
</script>

<template>
  <div v-if="!booted" class="flex h-full items-center justify-center">
    <p class="ident text-sm text-ink-500">loading…</p>
  </div>

  <div
    v-else-if="identityError"
    class="flex h-full items-center justify-center p-6"
  >
    <div class="max-w-md border border-bad-400/30 bg-bad-900/40 p-5">
      <h1 class="mb-2 text-sm font-semibold text-bad-400">Not signed in</h1>
      <p class="text-sm text-ink-300">{{ identityError }}</p>
    </div>
  </div>

  <div v-else class="flex h-full">
    <!-- Fixed rail. Navigation never competes with the data for attention. -->
    <aside
      class="flex w-56 shrink-0 flex-col border-r border-panel-700 bg-panel-900"
    >
      <div class="border-b border-panel-700 px-4 py-4">
        <RouterLink to="/" class="block">
          <span
            class="ident block text-lg leading-none font-bold tracking-tight text-brand-400"
          >
            aem
          </span>
          <span class="mt-1 block text-[10px] tracking-[0.18em] text-ink-500 uppercase">
            extension manager
          </span>
        </RouterLink>
      </div>

      <nav class="flex-1 overflow-y-auto py-3">
        <RouterLink
          v-for="item in nav.items"
          :key="item.to"
          :to="item.to"
          class="block py-1.5 pr-4 text-sm transition-colors"
          :class="linkCls(item.to)"
        >
          {{ item.label }}
        </RouterLink>

        <template v-if="nav.adminItems.length">
          <p
            class="mt-5 mb-1 px-4 text-[10px] tracking-[0.18em] text-ink-500 uppercase"
          >
            Admin
          </p>
          <RouterLink
            v-for="item in nav.adminItems"
            :key="item.to"
            :to="item.to"
            class="block py-1.5 pr-4 text-sm transition-colors"
            :class="linkCls(item.to)"
          >
            {{ item.label }}
          </RouterLink>
        </template>
      </nav>

      <div class="border-t border-panel-700 px-4 py-3">
        <p class="truncate text-xs text-ink-300" :title="identity!.email">
          {{ identity!.email }}
        </p>
        <p class="mt-0.5 text-[11px] text-ink-500">
          <span
            class="uppercase"
            :class="isAdmin() ? 'text-accent-400' : 'text-ink-500'"
          >
            {{ identity!.role }}
          </span>
          <span v-if="identity!.minExt !== null" class="ident">
            · {{ identity!.minExt }}–{{ identity!.maxExt }}
          </span>
        </p>

        <!-- Leaving has to be reachable from wherever impersonation left us,
             including the zero-privilege view, so it lives in the shell. -->
        <template v-if="viewingAs">
          <p class="mt-2 text-[11px] text-warn-400">
            viewing as this user — signed in as
            <span class="ident break-all">{{ viewingAs }}</span>
          </p>
          <Btn class="mt-1.5 w-full" @click="stopViewAs()">
            Stop viewing as
          </Btn>
        </template>
        <Btn
          v-else-if="isAdmin()"
          class="mt-2 w-full"
          title="Load the GUI with another user's privileges"
          @click="picking = true"
        >
          View as…
        </Btn>

        <ThemeToggle class="mt-3" />
      </div>
    </aside>

    <main class="min-w-0 flex-1 overflow-y-auto">
      <!-- Impersonation changes what every screen means. An admin who forgets
           they are in it will read a legitimately empty list as a bug. -->
      <div
        v-if="viewingAs"
        class="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-warn-400/30 bg-warn-900 px-6 py-2"
      >
        <p class="text-xs text-warn-400">
          Viewing as
          <span class="ident font-semibold">{{ identity!.email }}</span>
          <span class="text-warn-400/70">
            ({{ viewedPrivileges }}) — changes you make here are real, and are
            audited as you.
          </span>
        </p>
        <Btn class="shrink-0" @click="stopViewAs()">Stop</Btn>
      </div>
      <RouterView />
    </main>

    <ViewAsDialog v-if="picking" @close="picking = false" />

    <!-- Toasts. A revealed secret is sticky: it is shown exactly once and
         must not disappear before it has been copied. -->
    <div class="pointer-events-none fixed right-4 bottom-4 z-50 flex w-96 flex-col gap-2">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="elev pointer-events-auto border px-3 py-2.5"
        :class="
          t.kind === 'ok'
            ? 'border-ok-400/30 bg-ok-900 text-ok-400'
            : 'border-bad-400/30 bg-bad-900 text-bad-400'
        "
      >
        <div class="flex items-start justify-between gap-3">
          <p class="text-sm">{{ t.text }}</p>
          <button
            class="shrink-0 text-current opacity-60 hover:opacity-100"
            aria-label="Dismiss"
            @click="dismiss(t.id)"
          >
            ✕
          </button>
        </div>
        <div v-if="t.sticky" class="mt-2">
          <code
            class="ident block rounded-sm bg-panel-950/70 px-2 py-1.5 text-xs break-all text-ink-100 select-all"
          >
            {{ t.sticky }}
          </code>
          <p class="mt-1 text-[11px] opacity-70">
            Shown once — it cannot be retrieved later.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
