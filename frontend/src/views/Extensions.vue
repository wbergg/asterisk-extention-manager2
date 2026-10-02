<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { api, type Extension, type Pbx, type ProfileOption } from "../api";
import Btn from "../components/Btn.vue";
import Field from "../components/Field.vue";
import Modal from "../components/Modal.vue";
import Panel from "../components/Panel.vue";
import { errorText, identity, notify } from "../state";

const rows = ref<Extension[]>([]);
const pbxes = ref<Pbx[]>([]);
const profiles = ref<ProfileOption[]>([]);
const loading = ref(true);
const saving = ref(false);
const creating = ref(false);

const form = ref({
  pbx_id: "",
  number: "",
  display_name: "",
  tech: "pjsip" as "pjsip" | "sccp",
  profile_id: "" as string,
  context: "",
  // Blank means "generate one". Supplying it is what makes adopting an existing
  // fleet possible: the handsets keep the password they are already registered
  // with instead of every one of them needing to be reprovisioned.
  secret: "",
  directory_only: false,
});

/** Per-extension attribute overlay, edited as JSON — the escape hatch for the
 *  one endpoint in twenty that needs a setting its profile does not carry. */
const editing = ref<Extension | null>(null);
const overridesText = ref("");
const editSaving = ref(false);

/**
 * What to do with the secret on save.
 *
 * Three states rather than one field, because "leave the field empty" cannot
 * mean both "generate a new one" (what it means on create) and "don't touch it"
 * (what it has to mean on edit — most edits are a display name).
 */
const secretMode = ref<"keep" | "generate" | "manual">("keep");
const secretText = ref("");

const rangeHint = computed(() => {
  const id = identity.value;
  if (!id || id.role === "admin") return "Admins may use any number.";
  if (id.minExt === null) return "You have no delegated range — ask an administrator.";
  return `Your range is ${id.minExt}–${id.maxExt}.`;
});

const techProfiles = computed(() =>
  profiles.value.filter((p) => p.tech === form.value.tech),
);

/** Options for the edit dialog. Keyed on the *edited* extension's tech, not on
 *  the create form's — they are different extensions, and using `techProfiles`
 *  here made the field's contents depend on whatever the create form was last
 *  left set to. */
const editProfiles = computed(() =>
  profiles.value.filter((p) => p.tech === editing.value?.tech),
);

async function load() {
  loading.value = true;
  try {
    // Profiles are fetched for every role, and a failure is no longer
    // swallowed. An extension without a profile expands to an endpoint with no
    // codecs — it registers and then fails every call — so the picker is not a
    // convenience, and a silently empty list used to hide the field entirely.
    const [exts, fleet, profs] = await Promise.all([
      api.listExtensions(),
      api.listPbx(),
      api.listProfileOptions(),
    ]);
    rows.value = exts;
    pbxes.value = fleet;
    profiles.value = profs;
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  form.value = {
    pbx_id: pbxes.value[0]?.id ?? "",
    number: "",
    display_name: "",
    tech: "pjsip",
    profile_id: "",
    context: "",
    secret: "",
    directory_only: false,
  };
  creating.value = true;
}

function openEdit(e: Extension) {
  editing.value = { ...e };
  overridesText.value = "";
  editSaving.value = false;
  secretMode.value = "keep";
  secretText.value = "";
}

async function saveEdit() {
  const e = editing.value;
  if (!e) return;

  let overrides: unknown;
  const text = overridesText.value.trim();
  if (text) {
    try {
      overrides = JSON.parse(text);
    } catch {
      notify("bad", "Overrides must be valid JSON");
      return;
    }
  }

  const supplied = secretText.value.trim();
  if (secretMode.value === "manual" && !supplied) {
    notify("bad", "Enter a secret, or choose Generate a new one");
    return;
  }

  editSaving.value = true;
  try {
    const r = await api.updateExtension(e.pbx_id, e.number, {
      display_name: e.display_name,
      profile_id: e.profile_id,
      context: e.context,
      ...(overrides ? { overrides } : {}),
      ...(secretMode.value === "generate" ? { rotate_secret: true } : {}),
      ...(secretMode.value === "manual" ? { secret: supplied } : {}),
    });
    // Sticky, as on create: a generated secret is shown exactly once and has to
    // survive long enough to reach the phone's config.
    if (r.secret) notify("ok", `Saved ${e.number} — new SIP secret:`, r.secret);
    else if (secretMode.value === "manual") {
      notify("ok", `Saved ${e.number} — secret updated`);
    } else notify("ok", `Saved ${e.number}`);
    editing.value = null;
    await load();
  } catch (err) {
    notify("bad", errorText(err));
  } finally {
    editSaving.value = false;
  }
}

async function create() {
  saving.value = true;
  try {
    const r = await api.createExtension({
      ...form.value,
      profile_id: form.value.profile_id || null,
      // Omitted entirely rather than sent empty, so the server takes its
      // "generate one" path instead of storing a blank password.
      ...(form.value.context.trim() ? { context: form.value.context.trim() } : {}),
      ...(form.value.secret.trim() ? { secret: form.value.secret.trim() } : {}),
    });
    creating.value = false;
    // Whether a password was generated is the server's answer, not something to
    // infer from this form's state: an adopted handset's password must never be
    // reported as a new one. The secret is returned exactly once, so make the
    // toast sticky — it has to survive long enough to reach the phone's config.
    if (r.generated && r.secret) {
      notify("ok", `Created ${r.number} — SIP secret:`, r.secret);
    } else if (form.value.secret.trim()) {
      // An adopted secret is one the operator already holds; echoing it back
      // stickily would just leave a credential on screen for no reason. Saying
      // so plainly is the point — "adopted" and "replaced" must not look alike.
      notify("ok", `Created ${r.number} — kept the password you supplied`);
    } else {
      notify("ok", `Created ${r.number}`);
    }
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    saving.value = false;
  }
}

async function rotate(e: Extension) {
  if (
    !confirm(
      `Generate a new secret for ${e.number}? The phone stops registering until it is reprovisioned.`,
    )
  ) {
    return;
  }
  try {
    const r = await api.updateExtension(e.pbx_id, e.number, { rotate_secret: true });
    if (r.secret) notify("ok", `New secret for ${e.number}:`, r.secret);
    await load();
  } catch (err) {
    notify("bad", errorText(err));
  }
}

async function remove(e: Extension) {
  if (!confirm(`Delete extension ${e.number}? The phone will stop working.`)) return;
  try {
    await api.deleteExtension(e.pbx_id, e.number);
    notify("ok", `Deleted ${e.number}`);
    await load();
  } catch (err) {
    notify("bad", errorText(err));
  }
}

onMounted(load);
</script>

<template>
  <div class="p-6">
    <header class="mb-5">
      <h1 class="text-xl font-semibold tracking-tight">Extensions</h1>
      <p class="mt-1 text-sm text-ink-500">{{ rangeHint }}</p>
    </header>

    <Panel title="Extensions" :subtitle="`${rows.length} total`">
      <template #actions>
        <Btn variant="primary" :disabled="!pbxes.length" @click="openCreate">
          New extension
        </Btn>
      </template>

      <p v-if="loading" class="px-4 py-6 text-sm text-ink-500">Loading…</p>
      <p v-else-if="!rows.length" class="px-4 py-6 text-sm text-ink-500">
        Nothing here yet.
      </p>
      <table v-else class="w-full text-sm">
        <thead>
          <tr class="border-b border-panel-700 text-left text-[11px] tracking-wide text-ink-500 uppercase">
            <th class="px-4 py-2 font-medium">Ext</th>
            <th class="px-4 py-2 font-medium">Name</th>
            <th class="px-4 py-2 font-medium">Tech</th>
            <th class="px-4 py-2 font-medium">PBX</th>
            <th class="px-4 py-2 font-medium">Profile</th>
            <th class="px-4 py-2 font-medium">Secret</th>
            <th class="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="e in rows"
            :key="`${e.pbx_id}/${e.number}`"
            class="border-b border-panel-800 last:border-0 hover:bg-panel-850/50"
          >
            <td class="ident px-4 py-2.5 font-medium text-ink-100">{{ e.number }}</td>
            <td class="px-4 py-2.5 text-ink-300">{{ e.display_name || "—" }}</td>
            <td class="px-4 py-2.5">
              <span class="text-xs" :class="e.tech === 'sccp' ? 'text-accent-400' : 'text-ink-300'">
                {{ e.tech }}
              </span>
              <span v-if="e.directory_only" class="ml-2 text-[11px] text-ink-500">
                directory only
              </span>
            </td>
            <td class="ident px-4 py-2.5 text-xs text-ink-500">{{ e.pbx_id }}</td>
            <td class="ident px-4 py-2.5 text-xs text-ink-500">
              {{ e.profile_id ?? "—" }}
            </td>
            <td class="px-4 py-2.5 text-xs">
              <span :class="e.secret_set ? 'text-ink-500' : 'text-warn-400'">
                {{ e.secret_set ? "set" : "none" }}
              </span>
            </td>
            <td class="px-4 py-2.5 text-right whitespace-nowrap">
              <Btn @click="openEdit(e)">Edit</Btn>
              <Btn v-if="!e.directory_only" class="ml-1.5" @click="rotate(e)">
                Rotate
              </Btn>
              <Btn variant="danger" class="ml-1.5" @click="remove(e)">Delete</Btn>
            </td>
          </tr>
        </tbody>
      </table>
    </Panel>

    <Modal v-if="creating" title="New extension" @close="creating = false">
      <div class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">PBX</span>
            <select
              v-model="form.pbx_id"
              class="w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-sm text-ink-100 focus:border-accent-400/60"
            >
              <option v-for="p in pbxes" :key="p.id" :value="p.id">{{ p.id }}</option>
            </select>
          </label>
          <label class="block">
            <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
              Technology
            </span>
            <select
              v-model="form.tech"
              class="w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-sm text-ink-100 focus:border-accent-400/60"
            >
              <option value="pjsip">PJSIP</option>
              <option value="sccp">SCCP (Cisco)</option>
            </select>
          </label>
        </div>

        <Field
          v-model="form.number"
          label="Extension number"
          mono
          type="text"
          inputmode="numeric"
          :hint="rangeHint"
        />
        <Field v-model="form.display_name" label="Display name" placeholder="Björn Åkesson" />

        <label class="block">
          <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
            Profile
          </span>
          <select
            v-model="form.profile_id"
            :disabled="!techProfiles.length"
            class="w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-sm text-ink-100 focus:border-accent-400/60 disabled:opacity-50"
          >
            <option value="">none</option>
            <option v-for="p in techProfiles" :key="p.id" :value="p.id">
              {{ p.name }}
            </option>
          </select>
          <span class="mt-1 block text-[11px] text-ink-500">
            <template v-if="techProfiles.length">
              Carries the codecs and endpoint options. Without one the endpoint
              is pushed with no codecs and every call fails.
            </template>
            <template v-else>
              No {{ form.tech }} profiles exist yet — create one under Profiles
              first. An extension without a profile is pushed with no codecs and
              cannot complete a call.
            </template>
          </span>
        </label>

        <Field
          v-model="form.context"
          label="Dialplan context"
          mono
          placeholder="aem-internal"
          hint="Where calls from this phone land. Blank uses aem-internal — set it to your own context when adopting an existing dialplan."
        />

        <Field
          v-if="!form.directory_only"
          v-model="form.secret"
          label="SIP secret"
          mono
          placeholder="leave blank to generate"
          hint="Supply the phone's existing password to adopt it without reprovisioning — at least 8 characters with an uppercase letter and a digit, no spaces. Generated and shown once if blank."
        />

        <label class="flex items-center gap-2.5">
          <input
            v-model="form.directory_only"
            type="checkbox"
            class="h-3.5 w-3.5 accent-[color:var(--color-accent-400)]"
          />
          <span class="text-sm text-ink-300">
            Directory only — phonebook entry with no SIP registration
          </span>
        </label>
      </div>

      <template #footer>
        <Btn @click="creating = false">Cancel</Btn>
        <Btn variant="primary" :busy="saving" @click="create">Create</Btn>
      </template>
    </Modal>

    <Modal
      v-if="editing"
      :title="`Edit ${editing.number}`"
      @close="editing = null"
    >
      <div class="space-y-4">
        <Field v-model="editing.display_name" label="Display name" />
        <Field
          v-model="editing.context"
          label="Dialplan context"
          mono
          hint="Where calls from this phone land."
        />

        <label class="block">
          <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
            Profile
          </span>
          <select
            v-model="editing.profile_id"
            :disabled="!editProfiles.length"
            class="w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-sm text-ink-100 focus:border-accent-400/60 disabled:opacity-50"
          >
            <option :value="null">none</option>
            <option v-for="p in editProfiles" :key="p.id" :value="p.id">
              {{ p.name }}
            </option>
          </select>
          <span class="mt-1 block text-[11px] text-ink-500">
            <template v-if="editProfiles.length">
              Carries the codecs and endpoint options. Without one the endpoint
              is pushed with no codecs and every call fails.
            </template>
            <template v-else>
              No {{ editing.tech }} profiles exist yet — create one under
              Profiles first.
            </template>
          </span>
        </label>

        <fieldset v-if="!editing.directory_only" class="block">
          <legend class="mb-1.5 block text-[11px] tracking-wide text-ink-500 uppercase">
            SIP secret
          </legend>
          <div class="space-y-1.5">
            <label class="flex items-center gap-2.5">
              <input
                v-model="secretMode"
                type="radio"
                value="keep"
                class="h-3.5 w-3.5 accent-[color:var(--color-accent-400)]"
              />
              <span class="text-sm text-ink-300">Leave unchanged</span>
            </label>
            <label class="flex items-center gap-2.5">
              <input
                v-model="secretMode"
                type="radio"
                value="generate"
                class="h-3.5 w-3.5 accent-[color:var(--color-accent-400)]"
              />
              <span class="text-sm text-ink-300">
                Generate a new one — shown once on save
              </span>
            </label>
            <label class="flex items-center gap-2.5">
              <input
                v-model="secretMode"
                type="radio"
                value="manual"
                class="h-3.5 w-3.5 accent-[color:var(--color-accent-400)]"
              />
              <span class="text-sm text-ink-300">Set it myself</span>
            </label>
          </div>

          <input
            v-if="secretMode === 'manual'"
            v-model="secretText"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="the phone's password"
            class="ident mt-2 w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-sm text-ink-100 placeholder:text-ink-500/60 focus:border-accent-400/60"
          />

          <span v-if="secretMode === 'manual'" class="mt-1 block text-[11px] text-ink-500">
            At least 8 characters with an uppercase letter and a digit, no
            spaces.
          </span>
          <span
            v-else-if="secretMode === 'generate' && editing.tech === 'sccp'"
            class="mt-1.5 block text-[11px] text-warn-400"
          >
            SCCP lines authenticate by device, so this secret is stored but
            never pushed to the PBX.
          </span>
          <span
            v-else-if="secretMode === 'generate'"
            class="mt-1.5 block text-[11px] text-warn-400"
          >
            The phone stops registering until it is reprovisioned with the new
            secret.
          </span>
        </fieldset>

        <label class="block">
          <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
            Attribute overrides
          </span>
          <textarea
            v-model="overridesText"
            rows="6"
            placeholder='{"endpoint": {"send_connected_line": "no"}}'
            class="ident w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-xs text-ink-100 focus:border-accent-400/60"
          />
          <span class="mt-1 block text-[11px] text-ink-500">
            Layered over the profile, keyed by object —
            <span class="ident">endpoint</span>, <span class="ident">aor</span>,
            <span class="ident">auth</span> for PJSIP,
            <span class="ident">line</span> for SCCP. An empty string removes an
            attribute the profile sets. Leave blank to keep the current
            overrides unchanged.
          </span>
        </label>
      </div>

      <template #footer>
        <Btn @click="editing = null">Cancel</Btn>
        <Btn variant="primary" :busy="editSaving" @click="saveEdit">Save</Btn>
      </template>
    </Modal>
  </div>
</template>
