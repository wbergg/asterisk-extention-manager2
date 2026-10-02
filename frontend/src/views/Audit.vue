<script setup lang="ts">
import { onMounted, ref } from "vue";

import { api, type AuditEntry } from "../api";
import Panel from "../components/Panel.vue";
import { errorText, notify } from "../state";

const rows = ref<AuditEntry[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    rows.value = await api.audit(200);
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
      <h1 class="text-xl font-semibold tracking-tight">Audit</h1>
      <p class="mt-1 text-sm text-ink-500">Every mutation, most recent first.</p>
    </header>

    <Panel title="Log" :subtitle="`${rows.length} entries`">
      <p v-if="loading" class="px-4 py-6 text-sm text-ink-500">Loading…</p>
      <table v-else class="w-full text-sm">
        <tbody>
          <tr v-for="a in rows" :key="a.id" class="border-b border-panel-800 last:border-0 hover:bg-panel-850/50">
            <td class="ident px-4 py-2 text-xs whitespace-nowrap text-ink-500">{{ a.created_at }}</td>
            <td class="ident px-4 py-2 text-xs text-ink-300">{{ a.actor }}</td>
            <td class="px-4 py-2 text-xs text-accent-400">{{ a.action }}</td>
            <td class="ident px-4 py-2 text-xs text-ink-300">{{ a.detail }}</td>
          </tr>
        </tbody>
      </table>
    </Panel>
  </div>
</template>
