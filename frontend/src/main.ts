import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";

import App from "./App.vue";
import "./style.css";
import { isAdmin, loadIdentity } from "./state";
import { initTheme } from "./theme";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: () => import("./views/PbxList.vue") },
    { path: "/pbx/:id", component: () => import("./views/PbxDetail.vue") },
    { path: "/extensions", component: () => import("./views/Extensions.vue") },
    { path: "/devices", component: () => import("./views/Devices.vue"), meta: { admin: true } },
    { path: "/directory", component: () => import("./views/Directory.vue") },
    { path: "/calls", component: () => import("./views/Calls.vue") },
    { path: "/admin/users", component: () => import("./views/Users.vue"), meta: { admin: true } },
    { path: "/admin/blocked", component: () => import("./views/Blocked.vue"), meta: { admin: true } },
    { path: "/admin/profiles", component: () => import("./views/Profiles.vue"), meta: { admin: true } },
    { path: "/admin/audit", component: () => import("./views/Audit.vue"), meta: { admin: true } },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

/**
 * Client-side guard only — it hides admin screens from non-admins, it does not
 * secure them. Every admin endpoint is independently enforced server-side by
 * the `/admin/*` middleware, which is the boundary that actually matters.
 */
router.beforeEach((to) => (to.meta.admin && !isAdmin() ? "/" : true));

initTheme();

// Identity has to resolve before the first render: the shell and the guard
// both depend on knowing the role.
loadIdentity().then(() => {
  createApp(App).use(router).mount("#app");
});
