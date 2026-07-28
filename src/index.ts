import createLibsidplayfp, {
    type LibsidplayfpWasmModule,
    type SidPlayerContext,
    type SidPlayerContextOptions
} from "../dist/libsidplayfp.js";

/**
 * Read a configuration variable, preferring the current name over the SIDFlow
 * alias this package kept for existing callers.
 *
 * Read on demand rather than captured at module load, so a host that configures
 * its environment after importing the loader is still honoured. Browsers and
 * workers have no `process`, which is the case the guard exists for.
 */
function readEnv(name: string, alias: string): string | undefined {
    if (typeof process === "undefined" || typeof process.env !== "object") {
        return undefined;
    }
    return (process.env[name] ?? process.env[alias])?.trim() || undefined;
}

/** Node-like: no DOM window, and a process to read the environment from. */
function isServerLikeEnvironment(): boolean {
    return typeof (globalThis as { window?: unknown }).window === "undefined"
        && typeof process !== "undefined";
}

/** Explicit path to one specific `.wasm`, for hosts that relocate it. */
function wasmPathOverride(): string | undefined {
    return readEnv("LIBSIDPLAYFP_WASM_PATH", "SIDFLOW_LIBSIDPLAYFP_WASM_PATH");
}

/**
 * Which SID emulation to load. Both are built from the same bindings and
 * shipped side by side — `dist/` is reSIDfp, `dist/sidlite/` is SIDLite. See
 * LIBSIDPLAYFP_WASM_ENGINE in docker/entrypoint.sh for how they are produced.
 */
export type SidEngine = "residfp" | "sidlite";

/**
 * SIDLite is the default: it sounds good and renders roughly an order of
 * magnitude faster, which is what bulk work such as classifying a corpus needs.
 * Once the mixer defects were fixed it was verified against reSIDfp on real
 * tunes — clean, unclipped, multi-SID included — and most listeners will not
 * hear the difference.
 *
 * Ask for `residfp` explicitly when the last few percent of fidelity is the
 * point. It is the cycle-accurate reference, and the remaining measurable gap
 * is DC offset: 0.003 against SIDLite's 0.10 on Commando.
 */
export const DEFAULT_SID_ENGINE: SidEngine = "sidlite";

export interface LoadLibsidplayfpOptions extends SidPlayerContextOptions {
    /**
     * Optional override for locating artifacts when bundlers relocate the WASM binary.
     * Defaults to the sibling dist/ directory.
     */
    locateFile?: SidPlayerContextOptions["locateFile"];

    /** Precedence: this value, then LIBSIDPLAYFP_WASM_ENGINE, then DEFAULT_SID_ENGINE. */
    engine?: SidEngine;
}

const artifactBaseUrl = new URL("../dist/", import.meta.url);
const sidliteArtifactBaseUrl = new URL("../dist/sidlite/", import.meta.url);

function envEngine(): SidEngine | undefined {
    const raw = readEnv("LIBSIDPLAYFP_WASM_ENGINE", "SIDFLOW_SID_ENGINE")?.toLowerCase();
    return raw === "residfp" || raw === "sidlite" ? raw : undefined;
}

export function resolveSidEngine(engine?: SidEngine): SidEngine {
    return engine ?? envEngine() ?? DEFAULT_SID_ENGINE;
}

/**
 * Memoised default modules, keyed by what actually determines the artifact:
 * the engine and the binary path override.
 *
 * The override is read on demand, so a host that changes it must get a module
 * built against the new path rather than whatever was cached under the old one.
 */
const cachedDefaultModulePromises = new Map<string, Promise<LibsidplayfpWasmModule>>();

function defaultModuleCacheKey(engine: SidEngine): string {
    return `${engine}\u0000${(isServerLikeEnvironment() ? wasmPathOverride() : undefined) ?? ""}`;
}

async function createModulePromise(
    options: LoadLibsidplayfpOptions
): Promise<LibsidplayfpWasmModule> {
    const engine = resolveSidEngine(options.engine);
    const baseUrl = engine === "sidlite" ? sidliteArtifactBaseUrl : artifactBaseUrl;

    const locate = options.locateFile ?? ((asset: string) => {
        // The path override names one specific binary, so it can only apply to
        // the engine the caller actually asked for.
        const override = isServerLikeEnvironment() ? wasmPathOverride() : undefined;
        return override ?? new URL(asset, baseUrl).href;
    });

    // reSIDfp keeps the static import so bundlers can see it. SIDLite is loaded
    // dynamically: it is the secondary artifact and must not become a hard
    // dependency of every bundle that only ever wants the reference engine.
    const factory = engine === "sidlite"
        ? (await import("../dist/sidlite/libsidplayfp.js")).default
        : createLibsidplayfp;

    const { engine: _engine, ...moduleOptions } = options;
    return await factory({
        ...moduleOptions,
        locateFile: locate
    });
}

function isCacheableDefaultLoad(options: LoadLibsidplayfpOptions): boolean {
    const keys = Object.keys(options);
    return keys.length === 0 || (keys.length === 1 && keys[0] === "engine");
}

export async function loadLibsidplayfp(
    options: LoadLibsidplayfpOptions = {}
): Promise<LibsidplayfpWasmModule> {
    if (isCacheableDefaultLoad(options)) {
        const key = defaultModuleCacheKey(resolveSidEngine(options.engine));
        let cached = cachedDefaultModulePromises.get(key);
        if (!cached) {
            // Evict on failure, or every later caller inherits the rejection and
            // a transient problem becomes permanent for the process.
            cached = createModulePromise(options).catch((error) => {
                cachedDefaultModulePromises.delete(key);
                throw error;
            });
            cachedDefaultModulePromises.set(key, cached);
        }
        return await cached;
    }

    return await createModulePromise(options);
}

export type {
    C64Model,
    CiaModel,
    CombinedWaveforms,
    EmulationConfig,
    EngineInfo,
    FilterConfig,
    LibsidplayfpWasmModule,
    ResolvedEmulationConfig,
    SamplingMethod,
    SidModel,
    SidPlayerContext,
    SidPlayerContextOptions,
    SidTuneInfo,
    TuneClock,
    TuneCompatibility,
    TuneSidModel
} from "../dist/libsidplayfp.js";

export { SidAudioEngine } from "./player.js";
export type { SidWriteTrace } from "./player.js";

/**
 * Which upstream releases this build contains.
 *
 * The npm version and the libsidplayfp version are the same number for a mirror
 * release and can differ after a downstream-only fix, so these constants — not
 * the package version — are the authority. See "Versioning" in the README.
 */
export {
    LIBRESIDFP_VERSION,
    LIBSIDPLAYFP_VERSION,
    PACKAGE_VERSION,
    UPSTREAM_COMMITS
} from "./upstream-versions.js";

export default loadLibsidplayfp;
