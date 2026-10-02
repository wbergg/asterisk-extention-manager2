<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import Panel from "../components/Panel.vue";
import { errorText, notify } from "../state";

interface Entry {
  pbx_id: string;
  number: string;
  display_name: string;
  display_name_ascii: string;
}

const rows = ref<Entry[]>([]);
const q = ref("");
const loading = ref(true);

const filtered = computed(() => {
  const needle = q.value.trim().toLowerCase();
  if (!needle) return rows.value;
  return rows.value.filter(
    (r) =>
      r.number.includes(needle) ||
      r.display_name.toLowerCase().includes(needle) ||
      r.display_name_ascii.toLowerCase().includes(needle),
  );
});

onMounted(async () => {
  try {
    const res = await fetch("/api/directory");
    rows.value = (await res.json()) as Entry[];
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="p-6">
    <header class="mb-5">
      <h1 class="text-xl font-semibold tracking-tight">Directory</h1>
      <p class="mt-1 text-sm text-ink-500">
        The same entries Cisco sets fetch from
        <code class="ident text-ink-300">/directory.xml</code>, where names are
        folded to ASCII because those phones render a legacy code page.
      </p>
    </header>

    <Panel title="Entries" :subtitle="`${filtered.length} shown`">
      <template #actions>
        <input
          v-model="q"
          placeholder="Filter…"
          class="rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1 text-xs text-ink-100 placeholder:text-ink-500/60 focus:border-accent-400/60"
        />
      </template>
      <p v-if="loading" class="px-4 py-6 text-sm text-ink-500">Loading…</p>
      <table v-else class="w-full text-sm">
        <thead>
          <tr class="border-b border-panel-700 text-left text-[11px] tracking-wide text-ink-500 uppercase">
            <th class="px-4 py-2 font-medium">Number</th>
            <th class="px-4 py-2 font-medium">Name</th>
            <th class="px-4 py-2 font-medium">As shown on phone</th>
            <th class="px-4 py-2 font-medium">PBX</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in filtered" :key="`${r.pbx_id}/${r.number}`" class="border-b border-panel-800 last:border-0 hover:bg-panel-850/50">
            <td class="ident px-4 py-2.5 text-ink-100">{{ r.number }}</td>
            <td class="px-4 py-2.5 text-ink-300">{{ r.display_name || "—" }}</td>
            <td class="ident px-4 py-2.5 text-xs" :class="r.display_name !== r.display_name_ascii ? 'text-warn-400' : 'text-ink-500'">
              {{ r.display_name_ascii || "—" }}
            </td>
            <td class="ident px-4 py-2.5 text-xs text-ink-500">{{ r.pbx_id }}</td>
          </tr>
        </tbody>
      </table>
    </Panel>
  </div>
</template>
