// Resolution shim, never published and never compiled.
//
// `index.ts` imports "./libsidplayfp.js" so that the specifier TypeScript emits
// into `dist/index.js` resolves to the emscripten glue sitting beside it — in
// whatever directory a consumer deploys those files to, not only one named
// `dist`. TypeScript takes the types for that specifier from the `.d.ts` next to
// this file and emits the specifier verbatim.
//
// Bun, though, runs the suite and the coverage gate against `src/` directly, and
// there is no glue in `src/`. This file is what it finds there: a re-export of
// the real artifact. `allowJs` is off and `include` is `src/**/*`, so tsc reads
// neither this file nor its counterpart under `sidlite/`.
export * from "../dist/libsidplayfp.js";
export { default } from "../dist/libsidplayfp.js";
