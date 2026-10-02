<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";

import { api, type Pbx } from "../api";
import Btn from "../components/Btn.vue";
import Field from "../components/Field.vue";
import Modal from "../components/Modal.vue";
import Panel from "../components/Panel.vue";
import StatePill from "../components/StatePill.vue";
import { errorText, isAdmin, notify } from "../state";

const rows = ref<Pbx[]>([]);
const loading = ref(true);
const busy = ref<string | null>(null);
let timer: number | undefined;

interface PbxForm {
  id: string;
  name: string;
  sccp_enabled: boolean;
}

const form = ref<PbxForm | null>(null);
const isNew = ref(false);
const saving = ref(false);
/** Shown right after creation; afterwards only the config bundle reveals them. */
const created = ref<{ id: string; ws_secret: string; ari_secret: string } | null>(null);

async function load() {
  try {
    rows.value = await api.listPbx();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    loading.value = false;
  }
}

async function resync(id: string) {
  busy.value = id;
  try {
    const r = await api.resync(id);
    notify(
      r.ok ? "ok" : "bad",
      r.ok
        ? `${id}: resync complete${r.quarantineReleased ? `, released ${r.quarantineReleased} quarantined` : ""}`
        : `${id}: ${r.error ?? "resync failed"}`,
    );
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    busy.value = null;
  }
}

function add() {
  form.value = { id: "", name: "", sccp_enabled: false };
  isNew.value = true;
}

function edit(r: Pbx) {
  form.value = {
    id: r.id,
    name: r.name,
    sccp_enabled: r.sccp_enabled === 1,
  };
  isNew.value = false;
}

async function save() {
  const f = form.value;
  if (!f) return;

  const id = f.id.trim().toLowerCase();
  if (isNew.value && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
    notify("bad", "Site id must be lowercase alphanumeric with dashes, 2–63 chars");
    return;
  }

  saving.value = true;
  try {
    if (isNew.value) {
      const r = await api.createPbx({
        id,
        name: f.name.trim() || id,
        sccp_enabled: f.sccp_enabled,
      });
      form.value = null;
      // Straight into the secrets modal: this is the only time they are legible.
      created.value = r;
    } else {
      await api.updatePbx(f.id, {
        name: f.name.trim(),
        sccp_enabled: f.sccp_enabled,
      });
      notify("ok", `Saved ${f.id}`);
      form.value = null;
    }
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    saving.value = false;
  }
}

/**
 * Deletion is irreversible and takes the call history with it, so it gets a
 * typed confirmation rather than a `confirm()` — the same reflex that makes you
 * type a repo name before deleting it.
 */
const doomed = ref<Pbx | null>(null);
const doomedExtensions = ref<number | null>(null);
const confirmText = ref("");
const purge = ref(false);
const deleting = ref(false);

async function askDelete(r: Pbx) {
  doomed.value = r;
  doomedExtensions.value = null;
  confirmText.value = "";
  purge.value = false;
  try {
    doomedExtensions.value = (await api.listExtensions(r.id)).length;
  } catch {
    // A count is a courtesy; failing to get one must not block the dialog.
  }
}

async function confirmDelete() {
  const d = doomed.value;
  if (!d || confirmText.value !== d.id) return;

  deleting.value = true;
  try {
    const r = await api.deletePbx(d.id, purge.value);
    const gone =
      `${r.deleted.extensions} extension(s), ${r.deleted.devices} device(s), ` +
      `${r.deleted.calls} call leg(s)`;
    if (purge.value && !r.purged) {
      notify("bad", `Deleted ${d.id} — ${gone} — but the PBX was not cleaned: ${r.purgeError}`);
    } else {
      notify("ok", `Deleted ${d.id} — ${gone}`);
    }
    doomed.value = null;
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    deleting.value = false;
  }
}

function copySecrets() {
  const c = created.value;
  if (!c) return;
  void navigator.clipboard.writeText(
    `pbx: ${c.id}\nws_secret: ${c.ws_secret}\nari_secret: ${c.ari_secret}`,
  );
  notify("ok", "Secrets copied to clipboard");
}

/** "3m", "2h", "5d" — precision beyond this is noise at a glance. */
function ago(seconds: number | null): string {
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** A heartbeat inside two minutes is the closest thing the list has to
 *  live connectivity, since it reads D1 rather than asking each DO. */
const isLive = (r: Pbx) => r.seconds_since_seen !== null && r.seconds_since_seen < 120;

const filesStale = (r: Pbx) =>
  r.observed_file_rev !== null && r.observed_file_rev !== r.file_rev;

onMounted(() => {
  void load();
  timer = window.setInterval(load, 15000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="p-6">
    <header class="mb-5">
      <h1 class="text-xl font-semibold tracking-tight">PBXes</h1>
      <p class="mt-1 text-sm text-ink-500">
        Reconciliation state per PBX. <span class="text-ink-300">State</span> is the
        verdict of the last reconcile, not connectivity — the dot and
        <span class="text-ink-300">seen</span> tell you whether the socket is up.
      </p>
    </header>

    <Panel title="All PBXes" :subtitle="`${rows.length} configured`">
      <template v-if="isAdmin()" #actions>
        <Btn variant="primary" @click="add">Add PBX</Btn>
      </template>

      <p v-if="loading" class="px-4 py-6 text-sm text-ink-500">Loading…</p>
      <p v-else-if="!rows.length" class="px-4 py-6 text-sm text-ink-500">
        No PBXes yet.
      </p>

      <table v-else class="w-full text-sm">
        <thead>
          <tr class="border-b border-panel-700 text-left text-[11px] tracking-wide text-ink-500 uppercase">
            <th class="px-4 py-2 font-medium">PBX</th>
            <th class="px-4 py-2 font-medium">State</th>
            <th class="px-4 py-2 font-medium">Seen</th>
            <th class="px-4 py-2 font-medium">Bundle</th>
            <th class="px-4 py-2 font-medium">Cursor</th>
            <th class="px-4 py-2 font-medium">Tech</th>
            <th class="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in rows"
            :key="r.id"
            class="border-b border-panel-800 last:border-0 hover:bg-panel-850/50"
          >
            <td class="px-4 py-2.5">
              <RouterLink :to="`/pbx/${r.id}`" class="group block">
                <span class="ident font-medium text-ink-100 group-hover:text-accent-400">
                  {{ r.id }}
                </span>
                <span class="ml-2 text-xs text-ink-500">{{ r.name }}</span>
              </RouterLink>
            </td>
            <td class="px-4 py-2.5">
              <StatePill :state="r.state" :live="isLive(r)" />
            </td>
            <td class="ident px-4 py-2.5 text-xs" :class="isLive(r) ? 'text-ink-300' : 'text-warn-400'">
              {{ ago(r.seconds_since_seen) }}
            </td>
            <td class="ident px-4 py-2.5 text-xs">
              <span :class="filesStale(r) ? 'text-warn-400' : 'text-ink-300'">
                {{ r.observed_file_rev ?? "—" }} / {{ r.file_rev }}
              </span>
              <span v-if="filesStale(r)" class="ml-1.5 text-[11px] text-warn-400">
                stale
              </span>
            </td>
            <td class="ident px-4 py-2.5 text-xs text-ink-300">{{ r.acked_seq }}</td>
            <td class="px-4 py-2.5 text-xs text-ink-500">
              <span v-if="r.sccp_enabled" class="text-accent-400">sccp</span>
              <span v-else>—</span>
            </td>
            <td class="px-4 py-2.5 text-right whitespace-nowrap">
              <template v-if="isAdmin()">
                <Btn @click="edit(r)">Edit</Btn>
                <Btn class="ml-1.5" :busy="busy === r.id" @click="resync(r.id)">
                  Resync
                </Btn>
                <Btn variant="danger" class="ml-1.5" @click="askDelete(r)">
                  Delete
                </Btn>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </Panel>

    <div
      v-for="r in rows.filter((x) => x.last_error)"
      :key="`err-${r.id}`"
      class="mt-4 border border-warn-400/25 bg-warn-900/40 px-4 py-3"
    >
      <p class="ident mb-1 text-xs text-warn-400">{{ r.id }}</p>
      <p class="text-sm text-ink-300">{{ r.last_error }}</p>
    </div>

    <Modal
      v-if="form"
      :title="isNew ? 'Add PBX' : `Edit ${form.id}`"
      @close="form = null"
    >
      <div class="space-y-4">
        <Field
          v-model="form.id"
          label="Site id"
          mono
          :readonly="!isNew"
          placeholder="sto-1"
          :hint="
            isNew
              ? 'Lowercase letters, digits and dashes. Also the URL path segment and the reconciler name — it cannot be changed later.'
              : 'Immutable: it names the Durable Object holding the reconcile cursor.'
          "
        />
        <Field
          v-model="form.name"
          label="Display name"
          placeholder="Stockholm"
          hint="Cosmetic — shown next to the id in this list."
        />
        <label class="flex items-center gap-2.5">
          <input
            v-model="form.sccp_enabled"
            type="checkbox"
            class="h-3.5 w-3.5 accent-[color:var(--color-accent-400)]"
          />
          <span class="text-sm text-ink-300">SCCP enabled (chan_sccp2 phones)</span>
        </label>
        <p class="text-[11px] text-ink-500">
          The SCCP flag feeds the rendered config bundle, so changing it bumps
          the revision — reapply the bundle on the PBX afterwards.
        </p>
      </div>

      <template #footer>
        <Btn @click="form = null">Cancel</Btn>
        <Btn variant="primary" :busy="saving" @click="save">
          {{ isNew ? "Create" : "Save" }}
        </Btn>
      </template>
    </Modal>

    <Modal v-if="created" :title="`${created.id} created`" @close="created = null">
      <p class="mb-3 text-sm text-warn-400">
        The PBX needs both before it can connect. This is the last time they
        appear outside the config bundle.
      </p>
      <dl class="space-y-3">
        <div>
          <dt class="text-[11px] tracking-wide text-ink-500 uppercase">
            ws_secret — websocket_client.conf
          </dt>
          <dd class="ident mt-1 border border-panel-700 bg-panel-950 px-2.5 py-1.5 text-xs break-all text-ink-100">
            {{ created.ws_secret }}
          </dd>
        </div>
        <div>
          <dt class="text-[11px] tracking-wide text-ink-500 uppercase">
            ari_secret — ari.conf
          </dt>
          <dd class="ident mt-1 border border-panel-700 bg-panel-950 px-2.5 py-1.5 text-xs break-all text-ink-100">
            {{ created.ari_secret }}
          </dd>
        </div>
      </dl>
      <p class="mt-3 text-[11px] text-ink-500">
        Both also appear in the config bundle on the PBX detail page, which is
        where you will actually apply them.
      </p>

      <template #footer>
        <Btn @click="copySecrets">Copy</Btn>
        <Btn variant="primary" @click="created = null">Done</Btn>
      </template>
    </Modal>

    <Modal v-if="doomed" :title="`Delete ${doomed.id}`" @close="doomed = null">
      <p class="text-sm text-ink-300">
        This removes the site and everything scoped to it, permanently:
      </p>
      <ul class="mt-2 space-y-1 text-sm text-ink-300">
        <li class="flex gap-2">
          <span class="text-bad-400">·</span>
          <span>
            <span class="ident">{{ doomedExtensions ?? "—" }}</span> extension(s)
            and their SCCP devices
          </span>
        </li>
        <li class="flex gap-2">
          <span class="text-bad-400">·</span>
          <span>the entire call log for this site</span>
        </li>
        <li class="flex gap-2">
          <span class="text-bad-400">·</span>
          <span>its blocked list, op log and reconcile cursor</span>
        </li>
      </ul>
      <p class="mt-2 text-[11px] text-ink-500">
        The audit trail is kept — it is not scoped to a PBX.
      </p>

      <label
        class="mt-4 flex items-start gap-2.5 border border-panel-700 bg-panel-950 px-3 py-2.5"
      >
        <input
          v-model="purge"
          type="checkbox"
          class="mt-0.5 h-3.5 w-3.5 accent-[color:var(--color-accent-400)]"
        />
        <span class="text-sm text-ink-300">
          Also remove the config from the PBX itself
          <span class="mt-0.5 block text-[11px] text-ink-500">
            Deletes every object this app pushed to
            <span class="ident">{{ doomed.id }}</span> over ARI before the
            record goes — trunks and anything else in the file layer are left
            alone. Requires the PBX to be connected; if it is not, the deletion
            still proceeds and you are told. Leave unticked to strand the config
            in place and keep the phones working.
          </span>
        </span>
      </label>

      <label class="mt-4 block">
        <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
          Type <span class="ident text-ink-300">{{ doomed.id }}</span> to confirm
        </span>
        <input
          v-model="confirmText"
          class="ident w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-sm text-ink-100 focus:border-bad-400/60"
          autocomplete="off"
        />
      </label>

      <template #footer>
        <Btn @click="doomed = null">Cancel</Btn>
        <Btn
          variant="danger"
          :disabled="confirmText !== doomed.id"
          :busy="deleting"
          @click="confirmDelete"
        >
          Delete permanently
        </Btn>
      </template>
    </Modal>
  </div>
</template>
