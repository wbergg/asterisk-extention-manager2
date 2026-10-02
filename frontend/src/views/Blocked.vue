<script setup lang="ts">
import { onMounted, ref } from "vue";

import { api, type Blocked, type Pbx } from "../api";
import Btn from "../components/Btn.vue";
import Field from "../components/Field.vue";
import Panel from "../components/Panel.vue";
import { errorText, notify } from "../state";

const rows = ref<Blocked[]>([]);
const pbxes = ref<Pbx[]>([]);
const loading = ref(true);
const saving = ref(false);
const form = ref({ pbx_id: "", number: "", reason: "" });

async function load() {
  try {
    const [b, f] = await Promise.all([api.listBlocked(), api.listPbx()]);
    rows.value = b;
    pbxes.value = f;
    if (!form.value.pbx_id) form.value.pbx_id = f[0]?.id ?? "";
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    loading.value = false;
  }
}

async function add() {
  if (!form.value.number.trim()) return notify("bad", "Number is required");
  saving.value = true;
  try {
    await api.block({ ...form.value });
    notify("ok", `Blocked ${form.value.number}`);
    form.value.number = "";
    form.value.reason = "";
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    saving.value = false;
  }
}

async function remove(b: Blocked) {
  try {
    await api.unblock(b.pbx_id, b.number);
    notify("ok", `Unblocked ${b.number}`);
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  }
}

onMounted(load);
</script>

<template>
  <div class="p-6">
    <header class="mb-5">
      <h1 class="text-xl font-semibold tracking-tight">Blocked extensions</h1>
      <p class="mt-1 max-w-3xl text-sm text-ink-500">
        Carve-outs inside a delegated range — numbers reserved for conference
        bridges, hunt groups or future use. These apply to administrators too,
        so a reserved number stays reserved.
      </p>
    </header>

    <Panel title="Add a block" class="mb-4">
      <div class="grid gap-3 px-4 py-4 sm:grid-cols-[10rem_10rem_1fr_auto] sm:items-end">
        <label class="block">
          <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">PBX</span>
          <select v-model="form.pbx_id" class="w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-sm text-ink-100 focus:border-accent-400/60">
            <option v-for="p in pbxes" :key="p.id" :value="p.id">{{ p.id }}</option>
          </select>
        </label>
        <Field v-model="form.number" label="Number" mono />
        <Field v-model="form.reason" label="Reason" placeholder="reserved for conference bridge" />
        <Btn variant="primary" size="md" :busy="saving" @click="add">Block</Btn>
      </div>
    </Panel>

    <Panel title="Blocked" :subtitle="`${rows.length} entries`">
      <p v-if="loading" class="px-4 py-6 text-sm text-ink-500">Loading…</p>
      <p v-else-if="!rows.length" class="px-4 py-6 text-sm text-ink-500">Nothing blocked.</p>
      <table v-else class="w-full text-sm">
        <tbody>
          <tr v-for="b in rows" :key="`${b.pbx_id}/${b.number}`" class="border-b border-panel-800 last:border-0 hover:bg-panel-850/50">
            <td class="ident px-4 py-2.5 text-ink-100">{{ b.number }}</td>
            <td class="ident px-4 py-2.5 text-xs text-ink-500">{{ b.pbx_id }}</td>
            <td class="px-4 py-2.5 text-ink-300">{{ b.reason || "—" }}</td>
            <td class="px-4 py-2.5 text-right">
              <Btn variant="danger" @click="remove(b)">Unblock</Btn>
            </td>
          </tr>
        </tbody>
      </table>
    </Panel>
  </div>
</template>
