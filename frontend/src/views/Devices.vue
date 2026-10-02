<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import {
  api,
  type Pbx,
  type Profile,
  type SccpButton,
  type SccpDevice,
  type SccpStatic,
} from "../api";
import Btn from "../components/Btn.vue";
import Field from "../components/Field.vue";
import Modal from "../components/Modal.vue";
import Panel from "../components/Panel.vue";
import { errorText, notify } from "../state";

/**
 * Args are positional after the kind, and `minArgs` in options.ts counts the
 * kind itself — so the hints below describe what goes in the args array, one
 * fewer than that number. Labels come from real 7961/7965 configs rather than
 * from the grammar, which names the slots but not what they mean.
 */
const BUTTON_KINDS: { kind: SccpButton["kind"]; hint: string }[] = [
  { kind: "line", hint: "number, label=…, caller_name=…, caller_number=…, ring=…" },
  { kind: "speed_dial", hint: "label, number" },
  { kind: "blf", hint: "label, number, hint@context" },
  { kind: "blf_speed_dial", hint: "label, number, hint@context" },
  { kind: "feature", hint: "label, feature" },
  { kind: "service", hint: "label, url" },
  { kind: "addon", hint: "label, type" },
  { kind: "empty", hint: "no arguments — renders an empty position" },
  { kind: "unused", hint: "no arguments — leaves the position unconfigured" },
];

const devices = ref<SccpDevice[]>([]);
const pbxes = ref<Pbx[]>([]);
const profiles = ref<Profile[]>([]);
const softkeys = ref<SccpStatic[]>([]);
const loading = ref(true);
const saving = ref(false);
const pbxFilter = ref("");

interface DeviceForm {
  isNew: boolean;
  pbx_id: string;
  sep_id: string;
  description: string;
  profile_id: string | null;
  softkey_profile: string;
  /** Per-device attribute overlay, edited as JSON. */
  overrides: string;
  buttons: SccpButton[];
}

const editing = ref<DeviceForm | null>(null);

interface StaticForm {
  isNew: boolean;
  pbx_id: string;
  section_type: "softkey_profile" | "template";
  name: string;
  attrsText: string;
}

const editingStatic = ref<StaticForm | null>(null);
const staticSaving = ref(false);

const mapToText = (m: Record<string, string>) =>
  Object.entries(m)
    .map(([k, v]) => `${k} = ${v}`)
    .join("\n");

function textToMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    // Values are comma-separated key lists, so only the first = splits.
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function prettyJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

const sccpPbxes = computed(() => pbxes.value.filter((p) => p.sccp_enabled === 1));

/** Softkey profiles available for the PBX currently being edited. */
const softkeyOptions = computed(() => {
  const forPbx = softkeys.value
    .filter(
      (s) => s.section_type === "softkey_profile" && s.pbx_id === editing.value?.pbx_id,
    )
    .map((s) => s.name);
  // chan_sccp2's built-in, always valid even with no row backing it.
  return [...new Set(["default", ...forPbx])];
});

async function load() {
  try {
    const [d, p, pr, st] = await Promise.all([
      api.listSccpDevices(pbxFilter.value || undefined),
      api.listPbx(),
      api.listProfiles(),
      api.listSccpStatic(pbxFilter.value || undefined),
    ]);
    devices.value = d;
    pbxes.value = p;
    profiles.value = pr.filter((x) => x.tech === "sccp");
    softkeys.value = st;
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    loading.value = false;
  }
}

function add() {
  editing.value = {
    isNew: true,
    pbx_id: pbxFilter.value || sccpPbxes.value[0]?.id || "",
    sep_id: "SEP",
    description: "",
    profile_id: null,
    softkey_profile: "default",
    overrides: "",
    buttons: [],
  };
}

function edit(d: SccpDevice) {
  const ov = prettyJson(d.overrides_json || "{}");
  editing.value = {
    isNew: false,
    pbx_id: d.pbx_id,
    sep_id: d.sep_id,
    description: d.description,
    profile_id: d.profile_id,
    softkey_profile: d.softkey_profile,
    overrides: ov === "{}" ? "" : ov,
    // Deep copy: the button rows are edited in place and must not mutate the list.
    buttons: d.buttons.map((b) => ({ ...b, args: [...b.args] })),
  };
}

function addStatic(type: "softkey_profile" | "template") {
  editingStatic.value = {
    isNew: true,
    pbx_id: pbxFilter.value || sccpPbxes.value[0]?.id || "",
    section_type: type,
    name: "",
    attrsText: "",
  };
}

function editStatic(s: SccpStatic) {
  let attrs: Record<string, string> = {};
  try {
    attrs = JSON.parse(s.attrs_json) as Record<string, string>;
  } catch {
    /* hand-edited row; start from empty rather than failing to open */
  }
  editingStatic.value = {
    isNew: false,
    pbx_id: s.pbx_id,
    section_type: s.section_type,
    name: s.name,
    attrsText: mapToText(attrs),
  };
}

async function saveStatic() {
  const f = editingStatic.value;
  if (!f) return;
  if (!f.pbx_id || !f.name.trim()) {
    notify("bad", "PBX and name are required");
    return;
  }
  staticSaving.value = true;
  try {
    await api.upsertSccpStatic({
      pbx_id: f.pbx_id,
      section_type: f.section_type,
      name: f.name.trim(),
      attrs: textToMap(f.attrsText),
    });
    notify("ok", `Saved ${f.name}`);
    editingStatic.value = null;
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    staticSaving.value = false;
  }
}

async function removeStatic(s: SccpStatic) {
  if (!confirm(`Delete ${s.section_type} "${s.name}"?`)) return;
  try {
    await api.deleteSccpStatic(s.pbx_id, s.section_type, s.name);
    notify("ok", `Deleted ${s.name}`);
    await load();
  } catch (e) {
    // Refused with a 409 if any device still references it.
    notify("bad", errorText(e));
  }
}

function addButton() {
  const f = editing.value;
  if (!f) return;
  const next = f.buttons.reduce((m, b) => Math.max(m, b.position), 0) + 1;
  f.buttons.push({ position: next, kind: "speed_dial", args: [] });
}

function removeButton(i: number) {
  editing.value?.buttons.splice(i, 1);
}

function moveButton(i: number, delta: number) {
  const f = editing.value;
  if (!f) return;
  const j = i + delta;
  if (j < 0 || j >= f.buttons.length) return;
  const a = f.buttons[i]!;
  const b = f.buttons[j]!;
  // Swap the positions, not just the array slots: position is the button.NNNN
  // index and is what actually orders them on the handset.
  [a.position, b.position] = [b.position, a.position];
  f.buttons.splice(i, 1);
  f.buttons.splice(j, 0, a);
}

/** args are edited as one comma-separated string, matching how sccp.conf reads. */
function argsText(b: SccpButton): string {
  return b.args.join(", ");
}
function setArgs(b: SccpButton, text: string) {
  b.args = text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const hintFor = (kind: string) =>
  BUTTON_KINDS.find((k) => k.kind === kind)?.hint ?? "";

async function save() {
  const f = editing.value;
  if (!f) return;
  if (!f.pbx_id) {
    notify("bad", "Pick a PBX");
    return;
  }
  const sep = f.sep_id.trim().toUpperCase();
  if (!/^SEP[0-9A-F]{12}$/.test(sep)) {
    notify("bad", "SEP id must be SEP followed by 12 hex digits");
    return;
  }

  let overrides: unknown = {};
  if (f.overrides.trim()) {
    try {
      overrides = JSON.parse(f.overrides);
    } catch {
      notify("bad", "Overrides must be valid JSON");
      return;
    }
  }

  saving.value = true;
  const payload = {
    description: f.description,
    profile_id: f.profile_id,
    softkey_profile: f.softkey_profile,
    overrides,
    buttons: f.buttons,
  };
  try {
    if (f.isNew) {
      await api.createSccpDevice({ pbx_id: f.pbx_id, sep_id: sep, ...payload });
    } else {
      await api.updateSccpDevice(f.pbx_id, sep, payload);
    }
    notify("ok", `Saved ${sep}`);
    editing.value = null;
    await load();
  } catch (e) {
    // The API validates the whole inventory, so this is where "device
    // references a line that does not exist" surfaces.
    notify("bad", errorText(e));
  } finally {
    saving.value = false;
  }
}

async function remove(d: SccpDevice) {
  if (!confirm(`Delete ${d.sep_id}? The phone will stop registering.`)) return;
  try {
    await api.deleteSccpDevice(d.pbx_id, d.sep_id);
    notify("ok", `Deleted ${d.sep_id}`);
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  }
}

const lineOf = (d: SccpDevice) =>
  d.buttons.find((b) => b.kind === "line")?.args[0] ?? null;

onMounted(load);
</script>

<template>
  <div class="p-6">
    <header class="mb-5">
      <h1 class="text-xl font-semibold tracking-tight">SCCP devices</h1>
      <p class="mt-1 max-w-3xl text-sm text-ink-500">
        One row per physical handset, keyed by its SEP id (the MAC). The lines a
        device binds are ordinary extensions with tech
        <span class="ident">sccp</span> — created on the Extensions page, bound
        here by a <span class="ident">line</span> button.
      </p>
    </header>

    <Panel title="Devices" :subtitle="`${devices.length} configured`">
      <template #actions>
        <select
          v-model="pbxFilter"
          class="rounded-sm border border-panel-600 bg-panel-950 px-2 py-1 text-xs text-ink-100"
          @change="load"
        >
          <option value="">All PBXes</option>
          <option v-for="p in sccpPbxes" :key="p.id" :value="p.id">{{ p.id }}</option>
        </select>
        <Btn variant="primary" @click="add">Add device</Btn>
      </template>

      <p v-if="loading" class="px-4 py-6 text-sm text-ink-500">Loading…</p>
      <p v-else-if="!devices.length" class="px-4 py-6 text-sm text-ink-500">
        No SCCP devices yet.
      </p>

      <table v-else class="w-full text-sm">
        <thead>
          <tr class="border-b border-panel-700 text-left text-[11px] tracking-wide text-ink-500 uppercase">
            <th class="px-4 py-2 font-medium">SEP id</th>
            <th class="px-4 py-2 font-medium">Description</th>
            <th class="px-4 py-2 font-medium">Line</th>
            <th class="px-4 py-2 font-medium">Softkeys</th>
            <th class="px-4 py-2 font-medium">Buttons</th>
            <th class="px-4 py-2 font-medium">PBX</th>
            <th class="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="d in devices"
            :key="`${d.pbx_id}/${d.sep_id}`"
            class="border-b border-panel-800 last:border-0 hover:bg-panel-850/50"
          >
            <td class="ident px-4 py-2.5 text-ink-100">{{ d.sep_id }}</td>
            <td class="px-4 py-2.5 text-ink-300">{{ d.description || "—" }}</td>
            <td class="ident px-4 py-2.5 text-ink-300">
              <span v-if="lineOf(d)">{{ lineOf(d) }}</span>
              <span v-else class="text-warn-400">none</span>
            </td>
            <td class="ident px-4 py-2.5 text-xs text-ink-500">
              {{ d.softkey_profile }}
            </td>
            <td class="px-4 py-2.5 text-xs text-ink-500">{{ d.buttons.length }}</td>
            <td class="ident px-4 py-2.5 text-xs text-ink-500">{{ d.pbx_id }}</td>
            <td class="px-4 py-2.5 text-right whitespace-nowrap">
              <Btn @click="edit(d)">Edit</Btn>
              <Btn variant="danger" class="ml-1.5" @click="remove(d)">Delete</Btn>
            </td>
          </tr>
        </tbody>
      </table>
    </Panel>

    <Panel
      class="mt-4"
      title="Softkey profiles and templates"
      subtitle="file layer — chan_sccp2 reads these at load, not over ARI"
    >
      <template #actions>
        <Btn @click="addStatic('template')">Add template</Btn>
        <Btn variant="primary" @click="addStatic('softkey_profile')">
          Add softkey profile
        </Btn>
      </template>

      <p v-if="!softkeys.length" class="px-4 py-6 text-sm text-ink-500">
        None defined. Devices fall back to chan_sccp2's built-in
        <span class="ident">default</span> profile.
      </p>

      <table v-else class="w-full text-sm">
        <thead>
          <tr class="border-b border-panel-700 text-left text-[11px] tracking-wide text-ink-500 uppercase">
            <th class="px-4 py-2 font-medium">Name</th>
            <th class="px-4 py-2 font-medium">Type</th>
            <th class="px-4 py-2 font-medium">Keys</th>
            <th class="px-4 py-2 font-medium">PBX</th>
            <th class="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="s in softkeys"
            :key="`${s.pbx_id}/${s.section_type}/${s.name}`"
            class="border-b border-panel-800 last:border-0 hover:bg-panel-850/50"
          >
            <td class="ident px-4 py-2.5 text-ink-100">{{ s.name }}</td>
            <td class="px-4 py-2.5 text-xs text-ink-300">{{ s.section_type }}</td>
            <td class="px-4 py-2.5 text-xs text-ink-500">
              {{ Object.keys(JSON.parse(s.attrs_json || "{}")).length }}
            </td>
            <td class="ident px-4 py-2.5 text-xs text-ink-500">{{ s.pbx_id }}</td>
            <td class="px-4 py-2.5 text-right whitespace-nowrap">
              <Btn @click="editStatic(s)">Edit</Btn>
              <Btn variant="danger" class="ml-1.5" @click="removeStatic(s)">
                Delete
              </Btn>
            </td>
          </tr>
        </tbody>
      </table>
    </Panel>

    <Modal
      v-if="editingStatic"
      wide
      :title="
        editingStatic.isNew
          ? `New ${editingStatic.section_type.replace('_', ' ')}`
          : `Edit ${editingStatic.name}`
      "
      @close="editingStatic = null"
    >
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
              PBX
            </span>
            <select
              v-model="editingStatic.pbx_id"
              :disabled="!editingStatic.isNew"
              class="w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-sm text-ink-100 disabled:opacity-50"
            >
              <option v-for="p in sccpPbxes" :key="p.id" :value="p.id">{{ p.id }}</option>
            </select>
          </label>
          <Field
            v-model="editingStatic.name"
            label="Name"
            mono
            :readonly="!editingStatic.isNew"
            placeholder="7961-common-softkeys"
          />
        </div>

        <label class="block">
          <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
            Keys — one <span class="ident">state = actions</span> per line
          </span>
          <textarea
            v-model="editingStatic.attrsText"
            rows="16"
            placeholder="on_hook = redial, new_call, forward_all&#10;connected = hold, end_call, transfer&#10;ring_in = answer, end_call"
            class="ident w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-xs text-ink-100"
          />
          <span class="mt-1 block text-[11px] text-ink-500">
            Pasted straight from sccp.conf. Only the first
            <span class="ident">=</span> splits, so comma-separated action lists
            survive intact. A key with no value clears that state.
          </span>
        </label>

        <p class="text-[11px] text-warn-400">
          A device referencing a softkey profile that does not exist is a hard
          reload failure, so deleting one is refused while any device still
          points at it.
        </p>
      </div>

      <template #footer>
        <Btn @click="editingStatic = null">Cancel</Btn>
        <Btn variant="primary" :busy="staticSaving" @click="saveStatic">Save</Btn>
      </template>
    </Modal>

    <Modal
      v-if="editing"
      wide
      :title="editing.isNew ? 'Add SCCP device' : `Edit ${editing.sep_id}`"
      @close="editing = null"
    >
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
              PBX
            </span>
            <select
              v-model="editing.pbx_id"
              :disabled="!editing.isNew"
              class="w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-sm text-ink-100 disabled:opacity-50"
            >
              <option v-for="p in sccpPbxes" :key="p.id" :value="p.id">{{ p.id }}</option>
            </select>
          </label>
          <Field
            v-model="editing.sep_id"
            label="SEP id"
            mono
            :readonly="!editing.isNew"
            placeholder="SEP001B2AC731B8"
            hint="SEP + the handset MAC, 12 hex digits."
          />
        </div>

        <Field
          v-model="editing.description"
          label="Description"
          placeholder="7961G — reception"
        />

        <div class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
              Softkey profile
            </span>
            <select
              v-model="editing.softkey_profile"
              class="w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-sm text-ink-100"
            >
              <option v-for="s in softkeyOptions" :key="s" :value="s">{{ s }}</option>
            </select>
            <span class="mt-1 block text-[11px] text-ink-500">
              A missing profile fails the whole reload, so this is checked on save.
            </span>
          </label>
          <label class="block">
            <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
              Device profile
            </span>
            <select
              v-model="editing.profile_id"
              class="w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-sm text-ink-100"
            >
              <option :value="null">none</option>
              <option v-for="p in profiles" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </select>
            <span class="mt-1 block text-[11px] text-ink-500">
              Shared device attributes — nat, dtmf, park, forwarding.
            </span>
          </label>
        </div>

        <div>
          <div class="mb-2 flex items-center justify-between">
            <span class="text-[11px] tracking-wide text-ink-500 uppercase">
              Buttons
            </span>
            <Btn @click="addButton">Add button</Btn>
          </div>

          <p v-if="!editing.buttons.length" class="border border-panel-700 bg-panel-950 px-3 py-4 text-sm text-ink-500">
            No buttons. A device with no <span class="ident">line</span> button
            cannot place or receive calls.
          </p>

          <div
            v-for="(b, i) in editing.buttons"
            :key="i"
            class="mb-1.5 border border-panel-700 bg-panel-950 px-3 py-2.5"
          >
            <div class="flex items-center gap-2">
              <span class="ident w-10 shrink-0 text-xs text-ink-500">
                {{ String(b.position).padStart(4, "0") }}
              </span>
              <select
                v-model="b.kind"
                class="w-40 shrink-0 rounded-sm border border-panel-600 bg-panel-900 px-2 py-1 text-xs text-ink-100"
              >
                <option v-for="k in BUTTON_KINDS" :key="k.kind" :value="k.kind">
                  {{ k.kind }}
                </option>
              </select>
              <input
                :value="argsText(b)"
                class="ident min-w-0 flex-1 rounded-sm border border-panel-600 bg-panel-900 px-2 py-1 text-xs text-ink-100"
                :placeholder="hintFor(b.kind)"
                @input="setArgs(b, ($event.target as HTMLInputElement).value)"
              />
              <div class="flex shrink-0 gap-1">
                <Btn :disabled="i === 0" @click="moveButton(i, -1)">↑</Btn>
                <Btn
                  :disabled="i === editing.buttons.length - 1"
                  @click="moveButton(i, 1)"
                >
                  ↓
                </Btn>
                <Btn variant="danger" @click="removeButton(i)">✕</Btn>
              </div>
            </div>
            <p class="ident mt-1 pl-12 text-[11px] text-ink-500">
              {{ hintFor(b.kind) }}
            </p>
          </div>
        </div>

        <label class="block">
          <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
            Attribute overrides
          </span>
          <textarea
            v-model="editing.overrides"
            rows="4"
            placeholder='{"device": {"dnd": "on"}}'
            class="ident w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-xs text-ink-100"
          />
          <span class="mt-1 block text-[11px] text-ink-500">
            Layered over the device profile, keyed by
            <span class="ident">device</span>. For one handset that differs from
            the rest — leave blank if the profile covers it.
          </span>
        </label>

        <p class="text-[11px] text-ink-500">
          Every write reloads the entire chan_sccp2 inventory, and one invalid
          object fails that reload while still acking success — so the whole
          PBX inventory is validated before this is stored.
        </p>
      </div>

      <template #footer>
        <Btn @click="editing = null">Cancel</Btn>
        <Btn variant="primary" :busy="saving" @click="save">Save</Btn>
      </template>
    </Modal>
  </div>
</template>
