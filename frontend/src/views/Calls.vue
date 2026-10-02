<script setup lang="ts">
import { onMounted, ref } from "vue";

import { api, ApiError, type CallLeg } from "../api";
import Panel from "../components/Panel.vue";
import { errorText, notify } from "../state";

const rows = ref<CallLeg[]>([]);
const loading = ref(true);
const denied = ref(false);

function fmt(s: string | null) {
  return s ? s.replace("T", " ").replace(/\.\d+Z?$/, "").slice(0, 19) : "—";
}

onMounted(async () => {
  try {
    rows.value = await api.cdr(undefined, 200);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) denied.value = true;
    else notify("bad", errorText(e));
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="p-6">
    <header class="mb-5">
      <h1 class="text-xl font-semibold tracking-tight">Call log</h1>
      <p class="mt-1 max-w-3xl text-sm text-ink-500">
        Reconstructed from the ARI event stream — there is no CDR event in ARI,
        so these values ride along as channel variables. Not billing-grade:
        events are lost while a PBX is disconnected and Asterisk does not replay
        them.
      </p>
    </header>

    <div v-if="denied" class="border border-panel-700 bg-panel-900 px-4 py-6 text-sm text-ink-500">
      You do not have call log access. An administrator can grant it on the Users screen.
    </div>

    <Panel v-else title="Recent calls" :subtitle="`${rows.length} legs`">
      <p v-if="loading" class="px-4 py-6 text-sm text-ink-500">Loading…</p>
      <p v-else-if="!rows.length" class="px-4 py-6 text-sm text-ink-500">
        No calls recorded yet.
      </p>
      <table v-else class="w-full text-sm">
        <thead>
          <tr class="border-b border-panel-700 text-left text-[11px] tracking-wide text-ink-500 uppercase">
            <th class="px-4 py-2 font-medium">Started</th>
            <th class="px-4 py-2 font-medium">From</th>
            <th class="px-4 py-2 font-medium">To</th>
            <th class="px-4 py-2 font-medium">Disposition</th>
            <th class="px-4 py-2 font-medium">Talk</th>
            <th class="px-4 py-2 font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.channel_id" class="border-b border-panel-800 last:border-0 hover:bg-panel-850/50">
            <td class="ident px-4 py-2.5 text-xs text-ink-300">{{ fmt(r.started_at) }}</td>
            <td class="ident px-4 py-2.5 text-ink-100">{{ r.src ?? "—" }}</td>
            <td class="ident px-4 py-2.5 text-ink-100">{{ r.dst ?? "—" }}</td>
            <td class="px-4 py-2.5 text-xs">
              <span :class="r.disposition === 'ANSWERED' ? 'text-ok-400' : 'text-ink-500'">
                {{ r.disposition ?? "—" }}
              </span>
            </td>
            <td class="ident px-4 py-2.5 text-xs text-ink-300">{{ r.billsec ?? "—" }}s</td>
            <td class="ident px-4 py-2.5 text-xs text-ink-500">{{ r.duration ?? "—" }}s</td>
          </tr>
        </tbody>
      </table>
    </Panel>
  </div>
</template>
