/// <reference types="@cloudflare/vitest-plugin/types" />

/** Vite's ?raw suffix, used to load the D1 schema into the test worker. */
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
