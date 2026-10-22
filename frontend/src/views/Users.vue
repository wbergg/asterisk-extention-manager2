<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { api, type AppUser } from "../api";
import Btn from "../components/Btn.vue";
import Field from "../components/Field.vue";
import Modal from "../components/Modal.vue";
import Panel from "../components/Panel.vue";
import { errorText, identity, notify, startViewAs } from "../state";

const rows = ref<AppUser[]>([]);
const loading = ref(true);
const editing = ref<AppUser | null>(null);
const isNew = ref(false);
/** The row's email as persisted, so a changed email is sent as a rename. */
const originalEmail = ref("");
const saving = ref(false);
const removing = ref<string | null>(null);

const adminCount = computed(() => rows.value.filter((u) => u.role === "admin").length);

/**
 * Mirrors the server's guardrails so the button explains itself rather than
 * failing at the API. The server enforces them regardless.
 *
 * Judged on the persisted row, not on `editing` — an unsaved role change in the
 * modal must not decide whether someone is still the last admin.
 */
function blockedReason(email: string): string | null {
  if (email === identity.value?.email) return "You cannot remove your own account";
  const saved = rows.value.find((r) => r.email === email);
  if (saved?.role === "admin" && adminCount.value <= 1) {
    return "The last admin cannot be removed";
  }
  return null;
}

const blank = (): AppUser => ({
  email: "",
  role: "user",
  display_name: "",
  min_ext: null,
  max_ext: null,
  call_log_access: 0,
  created_at: "",
});

async function load() {
  try {
    rows.value = await api.listUsers();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    loading.value = false;
  }
}

function add() {
  editing.value = blank();
  isNew.value = true;
  originalEmail.value = "";
}

function edit(u: AppUser) {
  editing.value = { ...u };
  isNew.value = false;
  originalEmail.value = u.email;
}

async function save() {
  const u = editing.value;
  if (!u) return;
  if (!u.email.trim()) {
    notify("bad", "Email is required");
    return;
  }
  if (u.min_ext !== null && u.max_ext !== null && Number(u.min_ext) > Number(u.max_ext)) {
    notify("bad", "Lowest extension must not exceed highest");
    return;
  }

  saving.value = true;
  try {
    await api.upsertUser({
      email: u.email.trim().toLowerCase(),
      role: u.role,
      display_name: u.display_name,
      min_ext: u.min_ext === null || u.min_ext === ("" as never) ? null : Number(u.min_ext),
      max_ext: u.max_ext === null || u.max_ext === ("" as never) ? null : Number(u.max_ext),
      call_log_access: u.call_log_access === 1 || (u.call_log_access as unknown) === true,
      previous_email: isNew.value ? undefined : originalEmail.value,
    });
    notify("ok", `Saved ${u.email}`);
    editing.value = null;
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    saving.value = false;
  }
}

async function remove(email: string) {
  const reason = blockedReason(email);
  if (reason) {
    notify("bad", reason);
    return;
  }
  if (
    !confirm(
      `Remove ${email}?\n\nThey keep signing in through Access but lose every ` +
        `privilege here. Extensions they own are left in place.`,
    )
  ) {
    return;
  }

  removing.value = email;
  try {
    const r = await api.deleteUser(email);
    notify(
      "ok",
      r.orphanedExtensions
        ? `Removed ${email} — ${r.orphanedExtensions} extension(s) now unowned`
        : `Removed ${email}`,
    );
    if (editing.value && originalEmail.value === email) editing.value = null;
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    removing.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="p-6">
    <header class="mb-5">
      <h1 class="text-xl font-semibold tracking-tight">Users</h1>
      <p class="mt-1 max-w-3xl text-sm text-ink-500">
        Cloudflare Access decides <em>who can sign in</em>; this decides
        <em>what they can do</em>. Someone Access lets through who has no row here
        can sign in but has no privileges — add them below to grant a range.
      </p>
    </header>

    <Panel title="Accounts" :subtitle="`${rows.length} provisioned`">
      <template #actions>
        <Btn variant="primary" @click="add">Add user</Btn>
      </template>

      <p v-if="loading" class="px-4 py-6 text-sm text-ink-500">Loading…</p>
      <table v-else class="w-full text-sm">
        <thead>
          <tr class="border-b border-panel-700 text-left text-[11px] tracking-wide text-ink-500 uppercase">
            <th class="px-4 py-2 font-medium">Email</th>
            <th class="px-4 py-2 font-medium">Name</th>
            <th class="px-4 py-2 font-medium">Role</th>
            <th class="px-4 py-2 font-medium">Extension range</th>
            <th class="px-4 py-2 font-medium">Call log</th>
            <th class="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="u in rows"
            :key="u.email"
            class="border-b border-panel-800 last:border-0 hover:bg-panel-850/50"
          >
            <td class="ident px-4 py-2.5 text-ink-100">{{ u.email }}</td>
            <td class="px-4 py-2.5 text-ink-300">{{ u.display_name || "—" }}</td>
            <td class="px-4 py-2.5">
              <span
                class="rounded-sm border px-1.5 py-0.5 text-[11px] tracking-wide uppercase"
                :class="
                  u.role === 'admin'
                    ? 'border-accent-400/25 bg-accent-900 text-accent-400'
                    : 'border-panel-600 bg-panel-800 text-ink-300'
                "
              >
                {{ u.role }}
              </span>
            </td>
            <td class="ident px-4 py-2.5 text-ink-300">
              <template v-if="u.role === 'admin'">
                <span class="text-ink-500">unrestricted</span>
              </template>
              <template v-else-if="u.min_ext !== null">
                {{ u.min_ext }}–{{ u.max_ext }}
              </template>
              <template v-else>
                <span class="text-warn-400">none — cannot create</span>
              </template>
            </td>
            <td class="px-4 py-2.5 text-xs">
              <span :class="u.call_log_access ? 'text-ok-400' : 'text-ink-500'">
                {{ u.call_log_access ? "yes" : "no" }}
              </span>
            </td>
            <td class="px-4 py-2.5 text-right whitespace-nowrap">
              <Btn
                v-if="u.email !== identity?.email"
                :title="`Load the GUI with ${u.email}'s privileges`"
                @click="startViewAs(u.email)"
              >
                View as
              </Btn>
              <Btn class="ml-1.5" @click="edit(u)">Edit</Btn>
              <Btn
                variant="danger"
                class="ml-1.5"
                :disabled="blockedReason(u.email) !== null"
                :busy="removing === u.email"
                :title="blockedReason(u.email) ?? `Remove ${u.email}`"
                @click="remove(u.email)"
              >
                Remove
              </Btn>
            </td>
          </tr>
        </tbody>
      </table>
    </Panel>

    <Modal
      v-if="editing"
      :title="isNew ? 'Add user' : `Edit ${originalEmail}`"
      @close="editing = null"
    >
      <div class="space-y-4">
        <Field
          v-model="editing.email"
          label="Email"
          mono
          :readonly="!isNew && originalEmail === identity?.email"
          placeholder="name@example.com"
          :hint="
            !isNew && originalEmail === identity?.email
              ? 'You cannot change the email of your own account.'
              : 'Must match exactly what your identity provider asserts. Changing it moves their extensions to the new address.'
          "
        />
        <Field v-model="editing.display_name" label="Display name" />

        <label class="block">
          <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
            Role
          </span>
          <select
            v-model="editing.role"
            class="w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-sm text-ink-100 focus:border-accent-400/60"
          >
            <option value="user">user — self-service inside their range</option>
            <option value="admin">admin — full access to every PBX</option>
          </select>
        </label>

        <div v-if="editing.role === 'user'" class="grid grid-cols-2 gap-3">
          <Field v-model="editing.min_ext" label="Lowest extension" type="number" mono />
          <Field v-model="editing.max_ext" label="Highest extension" type="number" mono />
        </div>
        <p v-else class="text-[11px] text-ink-500">
          Admins bypass the extension range, but the blocked list still applies.
        </p>

        <label class="flex items-center gap-2.5">
          <input
            v-model="editing.call_log_access"
            type="checkbox"
            :true-value="1"
            :false-value="0"
            class="h-3.5 w-3.5 accent-[color:var(--color-accent-400)]"
          />
          <span class="text-sm text-ink-300">Can view the call log</span>
        </label>
      </div>

      <template #footer>
        <Btn
          v-if="!isNew"
          variant="danger"
          class="mr-auto"
          :disabled="blockedReason(originalEmail) !== null"
          :busy="removing === originalEmail"
          :title="blockedReason(originalEmail) ?? `Remove ${originalEmail}`"
          @click="remove(originalEmail)"
        >
          Remove
        </Btn>
        <Btn @click="editing = null">Cancel</Btn>
        <Btn variant="primary" :busy="saving" @click="save">Save</Btn>
      </template>
    </Modal>
  </div>
</template>
