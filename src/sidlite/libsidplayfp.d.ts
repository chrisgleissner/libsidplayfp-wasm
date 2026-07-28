// SIDLite is built from the same `bindings.cpp` as reSIDfp against a different
// emulation, so it presents the same surface. Declared by re-export rather than
// duplication: the build copies the full declarations beside each artifact.
export * from "../libsidplayfp.js";
export { default } from "../libsidplayfp.js";
