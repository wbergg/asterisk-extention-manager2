<script setup lang="ts">
import { onMounted, ref } from "vue";

import { api, type Profile } from "../api";
import Btn from "../components/Btn.vue";
import Field from "../components/Field.vue";
import Modal from "../components/Modal.vue";
import Panel from "../components/Panel.vue";
import { errorText, notify } from "../state";

const rows = ref<Profile[]>([]);
const loading = ref(true);
const saving = ref(false);

interface ProfileForm {
  isNew: boolean;
  id: string;
  tech: "pjsip" | "sccp";
  name: string;
  attrsText: string;
  no_answer_target: string;
  ring_timeout: number;
}

const editing = ref<ProfileForm | null>(null);

/**
 * Starting points rather than defaults — a profile is what replaces an
 * Asterisk `(!)` template, which does not exist in the astdb sorcery backend,
 * so every pushed object has to carry its attributes in full.
 */
const SKELETON: Record<"pjsip" | "sccp", string> = {
  pjsip: JSON.stringify(
    {
      endpoint: { disallow: "all", allow: "ulaw,alaw,g722", direct_media: "no" },
      aor: { qualify_frequency: "60" },
      auth: {},
    },
    null,
    2,
  ),
  sccp: JSON.stringify(
    { device: { nat: "auto", direct_media: "no" }, line: { incoming_limit: "6" } },
    null,
    2,
  ),
};

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

async function load() {
  try {
    rows.value = await api.listProfiles();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    loading.value = false;
  }
}

function add() {
  editing.value = {
    isNew: true,
    id: "",
    tech: "pjsip",
    name: "",
    attrsText: SKELETON.pjsip,
    no_answer_target: "Hangup()",
    ring_timeout: 20,
  };
}

function edit(p: Profile) {
  editing.value = {
    isNew: false,
    id: p.id,
    tech: p.tech,
    name: p.name,
    attrsText: pretty(p.attrs_json),
    no_answer_target: p.no_answer_target,
    ring_timeout: p.ring_timeout,
  };
}

function useSkeleton() {
  if (editing.value) editing.value.attrsText = SKELETON[editing.value.tech];
}

async function save() {
  const f = editing.value;
  if (!f) return;
  if (!f.id.trim() || !f.name.trim()) {
    notify("bad", "id and name are required");
    return;
  }

  let attrs: unknown;
  try {
    attrs = JSON.parse(f.attrsText);
  } catch {
    notify("bad", "Attributes must be valid JSON");
    return;
  }

  saving.value = true;
  try {
    await api.upsertProfile({
      id: f.id.trim(),
      tech: f.tech,
      name: f.name.trim(),
      attrs,
      no_answer_target: f.no_answer_target,
      ring_timeout: Number(f.ring_timeout),
    });
    // The server re-syncs every PBX: a profile change fans out to every
    // extension referencing it.
    notify("ok", `Saved ${f.name}`);
    editing.value = null;
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="p-6">
    <header class="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">Profiles</h1>
        <p class="mt-1 max-w-3xl text-sm text-ink-500">
          A profile is a validated attribute bag flattened onto every extension
          that references it — codecs, NAT handling, DTMF, AOR limits. It is what
          replaces an Asterisk <span class="ident">(!)</span> template, which has
          no equivalent in the sorcery backend these objects are pushed to.
        </p>
      </div>
      <Btn variant="primary" @click="add">Add profile</Btn>
    </header>

    <p v-if="loading" class="text-sm text-ink-500">Loading…</p>
    <div v-else class="space-y-4">
      <Panel
        v-for="p in rows"
        :key="p.id"
        :title="p.name"
        :subtitle="`${p.tech} · ring ${p.ring_timeout}s · no answer → ${p.no_answer_target}`"
      >
        <template #actions>
          <Btn @click="edit(p)">Edit</Btn>
        </template>
        <pre class="ident overflow-auto bg-panel-950 px-4 py-3 text-xs leading-relaxed text-ink-300">{{ pretty(p.attrs_json) }}</pre>
      </Panel>
      <p v-if="!rows.length" class="text-sm text-ink-500">No profiles defined.</p>
    </div>

    <Modal
      v-if="editing"
      wide
      :title="editing.isNew ? 'New profile' : `Edit ${editing.name}`"
      @close="editing = null"
    >
      <div class="space-y-4">
        <div class="grid grid-cols-3 gap-3">
          <Field
            v-model="editing.id"
            label="Id"
            mono
            :readonly="!editing.isNew"
            placeholder="desk"
            hint="Referenced by extensions."
          />
          <Field v-model="editing.name" label="Name" placeholder="Desk phone" />
          <label class="block">
            <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
              Technology
            </span>
            <select
              v-model="editing.tech"
              :disabled="!editing.isNew"
              class="w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-sm text-ink-100 disabled:opacity-50"
            >
              <option value="pjsip">PJSIP</option>
              <option value="sccp">SCCP</option>
            </select>
          </label>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <Field
            v-model="editing.ring_timeout"
            label="Ring timeout (s)"
            type="number"
            mono
          />
          <Field
            v-model="editing.no_answer_target"
            label="No-answer target"
            mono
            placeholder="Hangup()"
            hint="Dialplan line after the Dial fails, e.g. VoiceMail(${EXTEN}@default,u)"
          />
        </div>

        <label class="block">
          <span class="mb-1 flex items-center justify-between">
            <span class="text-[11px] tracking-wide text-ink-500 uppercase">
              Attributes (JSON)
            </span>
            <button
              class="text-[11px] text-accent-400 hover:underline"
              @click="useSkeleton"
            >
              insert skeleton
            </button>
          </span>
          <textarea
            v-model="editing.attrsText"
            rows="14"
            class="ident w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-xs text-ink-100 focus:border-accent-400/60"
          />
          <span class="mt-1 block text-[11px] text-ink-500">
            Keyed by object: <span class="ident">endpoint</span>,
            <span class="ident">aor</span>, <span class="ident">auth</span> for
            PJSIP; <span class="ident">device</span>,
            <span class="ident">line</span> for SCCP. Values are strings.
            <span class="ident">auth_type</span>, <span class="ident">username</span>,
            <span class="ident">callerid</span>, <span class="ident">context</span>
            and the auth/aor linkage are derived per extension and will override
            anything set here.
          </span>
        </label>

        <p class="text-[11px] text-warn-400">
          Saving re-syncs every PBX — a profile change fans out to every
          extension that references it.
        </p>
      </div>

      <template #footer>
        <Btn @click="editing = null">Cancel</Btn>
        <Btn variant="primary" :busy="saving" @click="save">Save</Btn>
      </template>
    </Modal>
  </div>
</template>
