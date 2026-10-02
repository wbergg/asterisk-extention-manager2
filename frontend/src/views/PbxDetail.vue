<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";

import { api, type PbxSettings, type PbxStatus } from "../api";
import Btn from "../components/Btn.vue";
import Field from "../components/Field.vue";
import Modal from "../components/Modal.vue";
import Panel from "../components/Panel.vue";
import StatePill from "../components/StatePill.vue";
import { errorText, isAdmin, notify } from "../state";

const route = useRoute();
const id = String(route.params.id);

const status = ref<PbxStatus | null>(null);
const bundle = ref<{ fileRev: number; files: { path: string; content: string }[] } | null>(null);
const shown = ref<string | null>(null);
const busy = ref(false);
let timer: number | undefined;

async function load() {
  try {
    status.value = await api.pbxStatus(id);
  } catch (e) {
    notify("bad", errorText(e));
  }
}

async function loadBundle() {
  busy.value = true;
  try {
    const b = await api.configBundle(id);
    bundle.value = b;
    shown.value = b.files[0]?.path ?? null;
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    busy.value = false;
  }
}

async function resync() {
  busy.value = true;
  try {
    const r = await api.resync(id);
    notify(r.ok ? "ok" : "bad", r.ok ? "Resync complete" : (r.error ?? "failed"));
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    busy.value = false;
  }
}

async function release(q: PbxStatus["quarantined"][number]) {
  try {
    await api.releaseQuarantine(id, q.config_class, q.object_type, q.object_id);
    notify("ok", `Released ${q.object_type}/${q.object_id}`);
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  }
}

/**
 * Renderer inputs. Edited as a whole object and re-merged with defaults
 * server-side, so a field this form does not expose is preserved rather than
 * silently reset.
 *
 * The two free-form maps are edited as `key = value` lines rather than as a row
 * editor: they mirror a .conf block verbatim, which is the form an operator is
 * already reading them in.
 */
const settings = ref<PbxSettings | null>(null);
const settingsOpen = ref(false);
const settingsSaving = ref(false);
const sccpGeneralText = ref("");
const pjsipGlobalText = ref("");
const channelvarsText = ref("");
const includesText = ref("");

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
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const splitList = (text: string) =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

async function openSettings() {
  try {
    const s = await api.pbxSettings(id);
    settings.value = s;
    sccpGeneralText.value = mapToText(s.sccp_general);
    pjsipGlobalText.value = mapToText(s.pjsip_global);
    channelvarsText.value = s.ari.channelvars.join("\n");
    includesText.value = s.dialplan.includes.join("\n");
    settingsOpen.value = true;
  } catch (e) {
    notify("bad", errorText(e));
  }
}

async function saveSettings() {
  const s = settings.value;
  if (!s) return;
  settingsSaving.value = true;
  try {
    await api.savePbxSettings(id, {
      ...s,
      ws: {
        ...s.ws,
        // Numbers come back as strings from the number inputs.
        connection_timeout: Number(s.ws.connection_timeout),
        reconnect_interval: Number(s.ws.reconnect_interval),
        reconnect_attempts: Number(s.ws.reconnect_attempts),
        pingpong_interval: Number(s.ws.pingpong_interval),
        pingpong_probes: Number(s.ws.pingpong_probes),
      },
      ari: { ...s.ari, channelvars: splitList(channelvarsText.value) },
      dialplan: { ...s.dialplan, includes: splitList(includesText.value) },
      sccp_general: textToMap(sccpGeneralText.value),
      pjsip_global: textToMap(pjsipGlobalText.value),
    });
    notify("ok", "Settings saved — re-apply the bundle to pick them up");
    settingsOpen.value = false;
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    settingsSaving.value = false;
  }
}

/**
 * Rotating disconnects the PBX until the new bundle is applied — its stored
 * password is wrong the instant this returns. That is unavoidable (the secret
 * has to change on both ends) but it must never be a surprise, hence the
 * confirmation and the "reconnects only after you re-apply" wording.
 */
const rotating = ref(false);
const askRotate = ref(false);
const rotated = ref<{ ws_secret: string; ari_secret: string } | null>(null);

async function rotate() {
  rotating.value = true;
  try {
    const r = await api.rotatePbxSecrets(id);
    askRotate.value = false;
    rotated.value = { ws_secret: r.ws_secret, ari_secret: r.ari_secret };
    // The bundle now renders at a new revision; pull it so the new values are
    // one click away rather than behind another round trip.
    await loadBundle();
    await load();
  } catch (e) {
    notify("bad", errorText(e));
  } finally {
    rotating.value = false;
  }
}

function copyRotated() {
  const r = rotated.value;
  if (!r) return;
  void navigator.clipboard.writeText(
    `pbx: ${id}\nws_secret: ${r.ws_secret}\nari_secret: ${r.ari_secret}`,
  );
  notify("ok", "Secrets copied to clipboard");
}

function copyAll() {
  if (!bundle.value) return;
  const text = bundle.value.files
    .map((f) => `; ===== ${f.path} =====\n${f.content}`)
    .join("\n\n");
  void navigator.clipboard.writeText(text);
  notify("ok", "Bundle copied to clipboard");
}

onMounted(() => {
  void load();
  timer = window.setInterval(load, 10000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="p-6">
    <header class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="ident text-xl font-semibold tracking-tight">{{ id }}</h1>
        <p class="mt-1 text-sm text-ink-500">Reconciliation detail</p>
      </div>
      <div class="flex gap-2">
        <Btn :busy="busy" @click="loadBundle">Config bundle</Btn>
        <Btn v-if="isAdmin()" @click="openSettings">Settings</Btn>
        <Btn v-if="isAdmin()" variant="danger" @click="askRotate = true">
          Rotate secrets
        </Btn>
        <Btn v-if="isAdmin()" variant="primary" :busy="busy" @click="resync">
          Force resync
        </Btn>
      </div>
    </header>

    <div v-if="status" class="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div class="border border-panel-700 bg-panel-900 px-4 py-3">
        <p class="text-[11px] tracking-wide text-ink-500 uppercase">State</p>
        <div class="mt-1.5">
          <StatePill :state="status.state" :live="status.connected" />
        </div>
      </div>
      <div class="border border-panel-700 bg-panel-900 px-4 py-3">
        <p class="text-[11px] tracking-wide text-ink-500 uppercase">Behind</p>
        <p class="ident mt-1 text-lg" :class="status.behind ? 'text-warn-400' : 'text-ink-100'">
          {{ status.behind }}
        </p>
        <p class="text-[11px] text-ink-500">{{ status.ackedSeq }} / {{ status.desiredSeq }}</p>
      </div>
      <div class="border border-panel-700 bg-panel-900 px-4 py-3">
        <p class="text-[11px] tracking-wide text-ink-500 uppercase">Bundle rev</p>
        <p class="ident mt-1 text-lg text-ink-100">
          {{ status.observedFileRev ?? "—" }}
        </p>
      </div>
      <div class="border border-panel-700 bg-panel-900 px-4 py-3">
        <p class="text-[11px] tracking-wide text-ink-500 uppercase">Quarantined</p>
        <p
          class="ident mt-1 text-lg"
          :class="status.quarantined.length ? 'text-bad-400' : 'text-ink-100'"
        >
          {{ status.quarantined.length }}
        </p>
      </div>
    </div>

    <div
      v-if="status?.lastError"
      class="mb-4 border border-warn-400/25 bg-warn-900/40 px-4 py-3 text-sm text-ink-300"
    >
      {{ status.lastError }}
    </div>

    <Panel
      v-if="status?.quarantined.length"
      title="Quarantined objects"
      subtitle="skipped by every pass until released"
      class="mb-4"
    >
      <table class="w-full text-sm">
        <tbody>
          <tr
            v-for="q in status.quarantined"
            :key="`${q.object_type}/${q.object_id}`"
            class="border-b border-panel-800 last:border-0"
          >
            <td class="ident px-4 py-2.5 text-ink-100">
              {{ q.object_type }}/{{ q.object_id }}
            </td>
            <td class="px-4 py-2.5 text-xs text-ink-500">
              {{ q.attempts }} attempts · HTTP {{ q.status_code ?? "—" }}
            </td>
            <td class="px-4 py-2.5 text-xs text-ink-300">{{ q.reason }}</td>
            <td class="px-4 py-2.5 text-right">
              <Btn v-if="isAdmin()" @click="release(q)">Release</Btn>
            </td>
          </tr>
        </tbody>
      </table>
    </Panel>

    <Panel
      v-if="bundle"
      title="Config bundle"
      :subtitle="`revision ${bundle.fileRev} — apply these on the PBX`"
    >
      <template #actions>
        <Btn @click="copyAll">Copy all</Btn>
      </template>
      <div class="flex flex-wrap gap-1 border-b border-panel-700 bg-panel-850 px-3 py-2">
        <button
          v-for="f in bundle.files"
          :key="f.path"
          class="ident rounded-sm px-2 py-1 text-xs transition-colors"
          :class="
            shown === f.path
              ? 'bg-accent-900 text-accent-400'
              : 'text-ink-500 hover:text-ink-100'
          "
          @click="shown = f.path"
        >
          {{ f.path }}
        </button>
      </div>
      <pre
        class="ident max-h-[28rem] overflow-auto bg-panel-950 px-4 py-3 text-xs leading-relaxed text-ink-300"
      >{{ bundle.files.find((f) => f.path === shown)?.content }}</pre>
    </Panel>

    <Modal
      v-if="settingsOpen && settings"
      wide
      :title="`Settings for ${id}`"
      @close="settingsOpen = false"
    >
      <div class="space-y-5">
        <section>
          <h3 class="mb-2 text-[11px] tracking-wide text-accent-400 uppercase">
            Control-plane websocket
          </h3>
          <div class="space-y-3">
            <Field
              v-model="settings.ws.uri"
              label="URI"
              mono
              hint="Where Asterisk dials out to. Must match the host this app is served from."
            />
            <div class="grid grid-cols-2 gap-3">
              <Field v-model="settings.ws.username" label="Username" mono />
              <Field
                v-model="settings.ws.ca_list_file"
                label="CA bundle file"
                mono
                placeholder="/etc/ssl/certs/ca-certificates.crt"
                hint="Asterisk does not use the system trust store."
              />
            </div>
            <div class="grid grid-cols-3 gap-3">
              <Field
                v-model="settings.ws.connection_timeout"
                label="Connect timeout (ms)"
                type="number"
                mono
              />
              <Field
                v-model="settings.ws.reconnect_interval"
                label="Reconnect (ms)"
                type="number"
                mono
              />
              <Field
                v-model="settings.ws.reconnect_attempts"
                label="Attempts"
                type="number"
                mono
              />
            </div>
            <div class="flex flex-wrap gap-4">
              <label class="flex items-center gap-2 text-sm text-ink-300">
                <input
                  v-model="settings.ws.tls_enabled"
                  type="checkbox"
                  class="h-3.5 w-3.5 accent-[color:var(--color-accent-400)]"
                />
                TLS enabled
              </label>
              <label class="flex items-center gap-2 text-sm text-ink-300">
                <input
                  v-model="settings.ws.verify_server_cert"
                  type="checkbox"
                  class="h-3.5 w-3.5 accent-[color:var(--color-accent-400)]"
                />
                Verify certificate
              </label>
              <label class="flex items-center gap-2 text-sm text-ink-300">
                <input
                  v-model="settings.ws.verify_server_hostname"
                  type="checkbox"
                  class="h-3.5 w-3.5 accent-[color:var(--color-accent-400)]"
                />
                Verify hostname
              </label>
            </div>
          </div>
        </section>

        <section>
          <h3 class="mb-2 text-[11px] tracking-wide text-accent-400 uppercase">
            ARI and dialplan
          </h3>
          <div class="grid grid-cols-2 gap-3">
            <Field v-model="settings.ari.user" label="ARI user" mono />
            <Field v-model="settings.ari.app" label="Stasis app" mono />
          </div>
          <div class="mt-3 grid grid-cols-2 gap-3">
            <Field
              v-model="settings.dialplan.context"
              label="Generated context"
              mono
              hint="The context this app owns in extensions.conf."
            />
            <label class="block">
              <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
                Includes (one per line)
              </span>
              <textarea
                v-model="includesText"
                rows="3"
                class="ident w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-xs text-ink-100"
              />
              <span class="mt-1 block text-[11px] text-ink-500">
                Contexts included <em>from</em> the generated one.
              </span>
            </label>
          </div>
          <label class="mt-3 block">
            <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
              Channel variables (one per line)
            </span>
            <textarea
              v-model="channelvarsText"
              rows="4"
              class="ident w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-xs text-ink-100"
            />
            <span class="mt-1 block text-[11px] text-ink-500">
              Entries containing <span class="ident">(</span> are invoked as
              dialplan functions — this is how the call log gets CDR data.
            </span>
          </label>
        </section>

        <section>
          <h3 class="mb-2 text-[11px] tracking-wide text-accent-400 uppercase">
            Raw config blocks
          </h3>
          <div class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
                pjsip.conf [global]
              </span>
              <textarea
                v-model="pjsipGlobalText"
                rows="6"
                placeholder="max_forwards = 70&#10;user_agent = Asterisk PBX"
                class="ident w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-xs text-ink-100"
              />
            </label>
            <label class="block">
              <span class="mb-1 block text-[11px] tracking-wide text-ink-500 uppercase">
                sccp.conf [general]
              </span>
              <textarea
                v-model="sccpGeneralText"
                rows="6"
                placeholder="bind = 0.0.0.0:2000&#10;keepalive = 60"
                class="ident w-full rounded-sm border border-panel-600 bg-panel-950 px-2.5 py-1.5 text-xs text-ink-100"
              />
              <span class="mt-1 block text-[11px] text-ink-500">
                <span class="ident">configuration_source = sorcery</span> is always
                emitted and cannot be overridden here.
              </span>
            </label>
          </div>
        </section>

        <p class="text-[11px] text-ink-500">
          All of this feeds the rendered bundle, so saving bumps its revision.
          The PBX will report itself stale until you apply the new files.
        </p>
      </div>

      <template #footer>
        <Btn @click="settingsOpen = false">Cancel</Btn>
        <Btn variant="primary" :busy="settingsSaving" @click="saveSettings">Save</Btn>
      </template>
    </Modal>

    <Modal v-if="askRotate" :title="`Rotate secrets for ${id}`" @close="askRotate = false">
      <p class="text-sm text-ink-300">
        Generates a new <span class="ident">ws_secret</span> and
        <span class="ident">ari_secret</span>, replacing both.
      </p>
      <p class="mt-3 text-sm text-warn-400">
        The PBX disconnects immediately and stays down until you apply the new
        bundle. Its stored password is wrong the moment this completes — it will
        retry on a backoff and keep failing until
        <span class="ident">websocket_client.conf</span> and
        <span class="ident">ari.conf</span> are updated on the box.
      </p>
      <p class="mt-3 text-[11px] text-ink-500">
        Calls in progress are unaffected — this is the control-plane connection,
        not call handling. Reconciliation stops until it reconnects.
      </p>

      <template #footer>
        <Btn @click="askRotate = false">Cancel</Btn>
        <Btn variant="danger" :busy="rotating" @click="rotate">
          Rotate and disconnect
        </Btn>
      </template>
    </Modal>

    <Modal v-if="rotated" title="New secrets" @close="rotated = null">
      <p class="mb-3 text-sm text-warn-400">
        Apply these to the PBX now — it cannot reconnect until you do.
      </p>
      <dl class="space-y-3">
        <div>
          <dt class="text-[11px] tracking-wide text-ink-500 uppercase">
            ws_secret — websocket_client.conf
          </dt>
          <dd class="ident mt-1 border border-panel-700 bg-panel-950 px-2.5 py-1.5 text-xs break-all text-ink-100">
            {{ rotated.ws_secret }}
          </dd>
        </div>
        <div>
          <dt class="text-[11px] tracking-wide text-ink-500 uppercase">
            ari_secret — ari.conf
          </dt>
          <dd class="ident mt-1 border border-panel-700 bg-panel-950 px-2.5 py-1.5 text-xs break-all text-ink-100">
            {{ rotated.ari_secret }}
          </dd>
        </div>
      </dl>
      <p class="mt-3 text-[11px] text-ink-500">
        The config bundle below has been reloaded at its new revision and
        already contains both.
      </p>

      <template #footer>
        <Btn @click="copyRotated">Copy</Btn>
        <Btn variant="primary" @click="rotated = null">Done</Btn>
      </template>
    </Modal>
  </div>
</template>
