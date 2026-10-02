<script setup lang="ts">
/**
 * Pick a user to view the GUI as.
 *
 * Admin-only, and the list comes from `/admin/users` — so this dialog can only
 * ever be opened *before* impersonating, which is why leaving is a control in
 * the shell rather than in here.
 */
import { computed, onMounted, ref } from "vue";

import { api, type AppUser } from "../api";
import { errorText, notify, startViewAs } from "../state";
import Btn from "./Btn.vue";
import Field from "./Field.vue";
import Modal from "./Modal.vue";

const emit = defineEmits<{ close: [] }>();

const rows = ref<AppUser[]>([]);
const loading = ref(true);
const filter = ref("");
const unprovisioned = ref("");

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(
    (u) =>
      u.email.includes(q) || u.display_name.toLowerCase().includes(q),
  );
});

function range(u: AppUser): string {
  if (u.role === "admin") return "unrestricted";
  if (u.min_ext === null) return "no range";
  return `${u.min_ext}–${u.max_ext}`;
}

onMounted(async () => {
  try {
    rows.value = await api.listUsers();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <Modal title="View as" wide @close="emit('close')">
    <p class="mb-4 text-sm text-ink-500">
      Loads the GUI with this user's privileges — their extension range, only
      the extensions they own, and no admin screens. Anything you do is real and
      is audited as
      <span class="ident text-ink-300">you (as them)</span>.
    </p>

    <Field
      v-model="filter"
      label="Find a user"
      placeholder="name or address"
      autofocus
    />

    <p v-if="loading" class="py-6 text-sm text-ink-500">Loading…</p>
    <p v-else-if="!shown.length" class="py-6 text-sm text-ink-500">
      No provisioned user matches.
    </p>
    <ul v-else class="mt-3 max-h-[46vh] divide-y divide-panel-800 overflow-y-auto">
      <li
        v-for="u in shown"
        :key="u.email"
        class="flex items-center justify-between gap-3 py-2"
      >
        <div class="min-w-0">
          <p class="ident truncate text-sm text-ink-100">{{ u.email }}</p>
          <p class="mt-0.5 text-[11px] text-ink-500">
            <span
              class="uppercase"
              :class="u.role === 'admin' ? 'text-accent-400' : ''"
            >
              {{ u.role }}
            </span>
            <span class="ident"> · {{ range(u) }}</span>
            <span v-if="u.display_name"> · {{ u.display_name }}</span>
          </p>
        </div>
        <Btn class="shrink-0" @click="startViewAs(u.email)">View as</Btn>
      </li>
    </ul>

    <!-- The most common thing an admin actually wants to check: what someone
         Access lets in but who has no row here is shown. -->
    <div class="mt-5 border-t border-panel-700 pt-4">
      <Field
        v-model="unprovisioned"
        label="Or an address with no account here"
        mono
        placeholder="newcomer@example.com"
        hint="Shows the zero-privilege view an unprovisioned sign-in gets."
      />
      <Btn
        class="mt-2"
        :disabled="!unprovisioned.trim()"
        @click="startViewAs(unprovisioned)"
      >
        View as unprovisioned
      </Btn>
    </div>

    <template #footer>
      <Btn @click="emit('close')">Cancel</Btn>
    </template>
  </Modal>
</template>
