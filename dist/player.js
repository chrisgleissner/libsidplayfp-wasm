import { loadLibsidplayfp, resolveSidEngine } from "./index.js";
const DEFAULT_CACHE_SECONDS = 600;
export class SidAudioEngine {
    modulePromise;
    module;
    context;
    sampleRate;
    stereo;
    maxCacheSeconds;
    configured = false;
    sidWriteTraceEnabled = false;
    originalSidBuffer = null;
    currentSongIndex = 0;
    cachePromise = null;
    cachedPcm = null;
    cacheSampleRate = 0;
    cacheChannels = 0;
    cacheCursor = 0;
    useCachePlayback = false;
    cacheToken = 0;
    pendingChunk = null;
    pendingChunkOffset = 0;
    kernalRom = null;
    basicRom = null;
    chargenRom = null;
    romSupportDisabled = false;
    romFailureLogged = false;
    engine;
    logRecoverableFailure(operation, error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.debug(`[SidAudioEngine] ${operation}`, { reason });
    }
    releaseContext(context) {
        const disposableContext = context;
        if (!disposableContext?.delete) {
            return;
        }
        try {
            if (disposableContext.isDeleted?.()) {
                return;
            }
            disposableContext.delete();
        }
        catch (error) {
            // Embind can already have destroyed the object after a failed load.
            this.logRecoverableFailure("Could not release a SID player context", error);
        }
    }
    constructor(options = {}) {
        const { module: moduleOverride, sampleRate, stereo, cacheSecondsLimit, ...loaderOptions } = options;
        this.sampleRate = sampleRate ?? 44100;
        this.stereo = stereo ?? true;
        this.maxCacheSeconds = cacheSecondsLimit ?? DEFAULT_CACHE_SECONDS;
        // A caller-supplied module has already chosen an engine; reporting the
        // resolved default in that case would be a guess, so record null instead.
        this.engine = moduleOverride ? null : resolveSidEngine(options.engine);
        this.modulePromise = moduleOverride ?? loadLibsidplayfp(loaderOptions);
    }
    async ensureModule() {
        if (this.module) {
            return this.module;
        }
        const capturedPromise = this.modulePromise;
        if (!capturedPromise) {
            throw new Error("SidAudioEngine has been disposed");
        }
        const module = await capturedPromise;
        if (this.modulePromise !== capturedPromise) {
            throw new Error("SidAudioEngine has been disposed");
        }
        if (!this.module) {
            this.module = module;
        }
        return this.module;
    }
    async createConfiguredContext() {
        const module = await this.ensureModule();
        const ctx = new module.SidPlayerContext();
        if (!ctx.configure(this.sampleRate, this.stereo)) {
            throw new Error(`Failed to configure SID player: ${ctx.getLastError()}`);
        }
        ctx.setSidWriteTraceEnabled?.(this.sidWriteTraceEnabled);
        return ctx;
    }
    async loadPatchedBuffer(patched) {
        const previousContext = this.context;
        const ctx = await this.createConfiguredContext();
        try {
            // The direct/native contract configures ROMs before a tune is loaded.
            // Reversing that order lets interrupt-driven and multi-SID tunes initialise
            // against built-in ROMs, then hold a frame after the later ROM injection.
            this.applySystemROMs(ctx);
            if (!ctx.loadSidBuffer(patched)) {
                throw new Error(ctx.getLastError());
            }
            if (!ctx.reset()) {
                throw new Error(ctx.getLastError());
            }
            this.context = ctx;
            this.configured = true;
            this.releaseContext(previousContext);
            return ctx;
        }
        catch (error) {
            this.releaseContext(ctx);
            throw error;
        }
    }
    cloneInput(data) {
        if (data instanceof Uint8Array) {
            return new Uint8Array(data);
        }
        return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    applySystemROMs(ctx) {
        if (this.romSupportDisabled) {
            return;
        }
        if (!this.kernalRom && !this.basicRom && !this.chargenRom) {
            return;
        }
        try {
            const success = ctx.setSystemROMs(this.kernalRom ?? null, this.basicRom ?? null, this.chargenRom ?? null);
            if (!success) {
                throw new Error(ctx.getLastError());
            }
        }
        catch (error) {
            this.romSupportDisabled = true;
            if (!this.romFailureLogged) {
                this.romFailureLogged = true;
                const reason = error instanceof Error ? error.message : String(error);
                console.warn("[SidAudioEngine] Custom ROM injection failed; falling back to built-in ROMs", {
                    reason,
                });
            }
            try {
                ctx.setSystemROMs(null, null, null);
            }
            catch (fallbackError) {
                const reason = fallbackError instanceof Error
                    ? fallbackError.message
                    : String(fallbackError);
                console.error("[SidAudioEngine] Failed to reset ROM configuration after custom ROM failure", {
                    reason,
                });
            }
        }
    }
    patchStartSong(buffer, songIndex) {
        if (buffer.length < 0x12) {
            throw new Error("SID buffer too small");
        }
        const headerOffset = 0x10;
        const patched = buffer.slice();
        const songs = (patched[0x0e] << 8) | patched[0x0f];
        const maxSong = songs > 0 ? songs : 1;
        const applied = Math.min(Math.max(1, Math.trunc(songIndex) + 1), maxSong);
        patched[headerOffset] = (applied >> 8) & 0xff;
        patched[headerOffset + 1] = applied & 0xff;
        return { data: patched, applied: applied - 1 };
    }
    async loadBufferAtSong(buffer, songIndex) {
        const { data, applied } = this.patchStartSong(buffer, songIndex);
        await this.loadPatchedBuffer(data);
        this.originalSidBuffer = buffer;
        this.currentSongIndex = applied;
        return applied;
    }
    async reloadCurrentSong() {
        if (!this.originalSidBuffer) {
            return 0;
        }
        return await this.loadBufferAtSong(this.originalSidBuffer, this.currentSongIndex);
    }
    /**
     * Which engine this instance requested, or null when the caller supplied
     * their own module. For what the loaded artifact actually is, see
     * `getEngineName()`.
     */
    getEngine() {
        return this.engine;
    }
    /** The builder name baked into the loaded artifact, e.g. "WasmSIDLite". */
    async getEngineName() {
        const module = await this.ensureModule();
        return typeof module.getSidEngineName === "function"
            ? module.getSidEngineName()
            : "unknown";
    }
    /**
     * Supply the C64 system ROMs.
     *
     * Strongly recommended: without them libsidplayfp initialises a tune but
     * never advances it, so many tunes render as silence or as a single held
     * frame. Sizes are exact — KERNAL 8192, BASIC 8192, CHARGEN 4096 bytes.
     *
     * The ROMs are copyrighted and are not shipped with this package. Dump them
     * from a real Commodore 64, and see the repository README ("System ROMs")
     * for the file names and search paths SIDFlow itself uses.
     */
    async setSystemROMs(kernal, basic, chargen) {
        this.kernalRom = kernal ? this.cloneInput(kernal) : null;
        this.basicRom = basic ? this.cloneInput(basic) : null;
        this.chargenRom = chargen ? this.cloneInput(chargen) : null;
        this.romSupportDisabled = false;
        this.resetCacheState();
        this.resetPendingChunk();
        if (!this.context) {
            return;
        }
        this.romSupportDisabled = false;
        this.romFailureLogged = false;
        try {
            const applied = this.context.setSystemROMs(this.kernalRom ?? null, this.basicRom ?? null, this.chargenRom ?? null);
            if (!applied) {
                throw new Error(this.context.getLastError());
            }
        }
        catch (error) {
            this.romSupportDisabled = true;
            if (!this.romFailureLogged) {
                this.romFailureLogged = true;
                const reason = error instanceof Error ? error.message : String(error);
                console.warn("[SidAudioEngine] Custom ROM injection failed; falling back to built-in ROMs", {
                    reason,
                });
            }
            try {
                this.context.setSystemROMs(null, null, null);
            }
            catch (fallbackError) {
                const reason = fallbackError instanceof Error
                    ? fallbackError.message
                    : String(fallbackError);
                console.error("[SidAudioEngine] Failed to reset ROM configuration after custom ROM failure", {
                    reason,
                });
            }
        }
        if (this.originalSidBuffer) {
            await this.reloadCurrentSong();
        }
    }
    async loadSidBuffer(data, songIndex = 0) {
        const candidate = this.cloneInput(data);
        const applied = await this.loadBufferAtSong(candidate, Math.max(0, Math.trunc(songIndex)));
        this.currentSongIndex = applied;
        this.resetCacheState();
        this.resetPendingChunk();
        // Don't start cache during initial load - it conflicts with rendering
        // Cache will be built on-demand for seeking
    }
    async selectSong(songIndex) {
        if (!this.originalSidBuffer) {
            throw new Error("Load a SID before selecting a song");
        }
        const applied = await this.loadBufferAtSong(this.originalSidBuffer, Math.max(0, Math.trunc(songIndex)));
        this.resetCacheState();
        this.resetPendingChunk();
        // Don't start cache during song selection - it conflicts with rendering
        return applied;
    }
    getChannels() {
        if (!this.context) {
            throw new Error("SID player not initialized");
        }
        return this.context.getChannels();
    }
    getSampleRate() {
        if (!this.context) {
            throw new Error("SID player not initialized");
        }
        return this.context.getSampleRate();
    }
    getTuneInfo() {
        if (!this.context) {
            return null;
        }
        return this.context.getTuneInfo();
    }
    reset() {
        if (!this.context) {
            return;
        }
        this.context.reset();
    }
    setSidWriteTraceEnabled(enabled) {
        this.sidWriteTraceEnabled = enabled;
        this.context?.setSidWriteTraceEnabled?.(enabled);
    }
    getAndClearSidWriteTraces() {
        const traces = this.context?.getAndClearSidWriteTraces?.();
        return Array.isArray(traces) ? traces.slice() : [];
    }
    renderCycles(cycles = 100000) {
        if (!this.context || !this.configured) {
            return null;
        }
        let chunk;
        try {
            chunk = this.context.render(cycles);
        }
        catch (error) {
            this.logRecoverableFailure("renderCycles failed", error);
            return null;
        }
        if (chunk === null) {
            return null;
        }
        if (chunk.length === 0) {
            return new Int16Array(0);
        }
        return chunk.slice();
    }
    async renderSeconds(seconds, cyclesPerChunk = 100000, onProgress) {
        if (seconds <= 0) {
            throw new Error("Duration must be greater than zero");
        }
        if (!this.context || !this.configured) {
            return new Int16Array(0);
        }
        // Direct rendering using main context (cache is for seeking only)
        const context = this.context;
        const sampleRate = context.getSampleRate();
        const channels = context.getChannels();
        const frames = Math.max(1, Math.floor(sampleRate * seconds));
        return this.renderFrames(frames, cyclesPerChunk, onProgress);
    }
    async renderFrames(frames, cyclesPerChunk = 100000, onProgress, { loop = false } = {}) {
        if (frames <= 0) {
            throw new Error("Frame count must be greater than zero");
        }
        if (!this.context || !this.configured) {
            return new Int16Array(0);
        }
        const context = this.context;
        const channels = context.getChannels();
        const totalSamples = frames * channels;
        const buffer = new Int16Array(totalSamples);
        let offset = 0;
        const chunkCycles = Math.max(1, Math.floor(cyclesPerChunk));
        let emptyReads = 0;
        const emptyReadLimit = Math.max(32, Math.ceil(frames / Math.max(1, chunkCycles)) * 4);
        while (offset < totalSamples) {
            const next = this.consumeChunk(chunkCycles);
            const chunk = next?.chunk ?? null;
            const start = next?.start ?? 0;
            if (!chunk || chunk.length <= start) {
                emptyReads += 1;
                if (loop && emptyReads < emptyReadLimit) {
                    if (!context.reset()) {
                        break;
                    }
                    this.resetPendingChunk();
                    continue;
                }
                break;
            }
            emptyReads = 0;
            const available = Math.min(chunk.length - start, totalSamples - offset);
            if (available <= 0) {
                break;
            }
            buffer.set(chunk.subarray(start, start + available), offset);
            offset += available;
            onProgress?.(offset);
            if (start + available < chunk.length) {
                // Preserve the remainder for the next call
                this.pendingChunk = chunk;
                this.pendingChunkOffset = start + available;
            }
            else {
                this.resetPendingChunk();
            }
        }
        return offset === buffer.length ? buffer : buffer.subarray(0, offset);
    }
    consumeChunk(cyclesPerChunk) {
        if (this.pendingChunk &&
            this.pendingChunkOffset < this.pendingChunk.length) {
            const chunk = this.pendingChunk;
            const start = this.pendingChunkOffset;
            this.pendingChunk = null;
            this.pendingChunkOffset = 0;
            return { chunk, start };
        }
        const chunk = this.renderCycles(cyclesPerChunk);
        if (!chunk || chunk.length === 0) {
            return null;
        }
        return { chunk, start: 0 };
    }
    async seekSeconds(seconds, cyclesPerChunk = 100000) {
        if (seconds <= 0) {
            this.useCachePlayback = this.cacheAvailable();
            this.cacheCursor = 0;
            this.resetPendingChunk();
            await this.reloadCurrentSong();
            return 0;
        }
        if (this.cacheAvailable()) {
            const samplesPerSecond = this.cacheSampleRate * this.cacheChannels;
            const targetSample = Math.floor(samplesPerSecond * seconds);
            if (targetSample < this.cachedPcm.length) {
                this.useCachePlayback = true;
                this.cacheCursor = targetSample;
                return targetSample;
            }
        }
        this.useCachePlayback = false;
        this.resetPendingChunk();
        await this.reloadCurrentSong();
        return this.fastForwardContext(seconds, cyclesPerChunk);
    }
    async waitForCacheReady() {
        // Cache construction is intentionally opt-in: pre-rendering the default
        // cache can retain over 100 MiB of PCM, which is unsuitable for mobile
        // browsers. Calling this existing readiness method is the explicit signal
        // that a caller intends to use cached seeking or waveform access.
        if (!this.cachePromise &&
            !this.cacheAvailable() &&
            this.originalSidBuffer) {
            this.startCache();
        }
        if (this.cachePromise) {
            try {
                await this.cachePromise;
            }
            catch (error) {
                this.logRecoverableFailure("The asynchronous render cache failed", error);
                return false;
            }
        }
        return this.cacheAvailable();
    }
    getCachedSegment(seconds, durationSeconds) {
        if (!this.cacheAvailable() || seconds < 0 || durationSeconds <= 0) {
            return null;
        }
        const samplesPerSecond = this.cacheSampleRate * this.cacheChannels;
        const start = Math.floor(samplesPerSecond * seconds);
        const length = Math.max(1, Math.floor(samplesPerSecond * durationSeconds));
        if (!this.cachedPcm || start + length > this.cachedPcm.length) {
            return null;
        }
        return this.cachedPcm.subarray(start, start + length).slice();
    }
    async fastForwardContext(seconds, cyclesPerChunk) {
        if (!this.context) {
            throw new Error("SID player not initialized");
        }
        const sampleRate = this.context.getSampleRate();
        const channels = this.context.getChannels();
        const targetSamples = Math.floor(sampleRate * channels * seconds);
        let skipped = 0;
        let iterations = 0;
        const maxIterations = Math.max(32, Math.ceil(targetSamples / cyclesPerChunk) * 4);
        while (skipped < targetSamples && iterations < maxIterations) {
            let chunk;
            try {
                chunk = this.context.render(cyclesPerChunk);
            }
            catch (error) {
                this.logRecoverableFailure("Fast-forward render stopped", error);
                break;
            }
            if (chunk === null || chunk.length === 0) {
                break;
            }
            skipped += chunk.length;
            iterations += 1;
        }
        return skipped;
    }
    resetCacheState() {
        this.cacheToken += 1;
        this.cachePromise = null;
        this.cachedPcm = null;
        this.cacheSampleRate = 0;
        this.cacheChannels = 0;
        this.cacheCursor = 0;
        this.useCachePlayback = false;
        this.resetPendingChunk();
    }
    resetPendingChunk() {
        this.pendingChunk = null;
        this.pendingChunkOffset = 0;
    }
    startCache() {
        if (!this.originalSidBuffer) {
            return;
        }
        const { data } = this.patchStartSong(this.originalSidBuffer, this.currentSongIndex);
        const token = this.cacheToken;
        const promise = this.buildCacheBuffer(data, token);
        this.cachePromise = promise;
        promise.finally(() => {
            if (this.cachePromise === promise) {
                this.cachePromise = null;
            }
        });
    }
    async buildCacheBuffer(buffer, token) {
        const module = await this.ensureModule();
        const ctx = new module.SidPlayerContext();
        try {
            if (!ctx.configure(this.sampleRate, this.stereo)) {
                return;
            }
            try {
                this.applySystemROMs(ctx);
            }
            catch (error) {
                this.logRecoverableFailure("Could not apply system ROMs to the render cache", error);
                return;
            }
            if (!ctx.loadSidBuffer(buffer)) {
                return;
            }
            if (!ctx.reset()) {
                return;
            }
            const channels = this.stereo ? 2 : 1;
            const maxSamples = Math.floor(this.sampleRate * channels * this.maxCacheSeconds);
            const chunks = [];
            let collected = 0;
            let iterationCount = 0;
            while (collected < maxSamples) {
                // Yield to event loop every 20 iterations (balanced for performance and responsiveness)
                if (++iterationCount % 20 === 0) {
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                let chunk;
                try {
                    chunk = ctx.render(100000);
                }
                catch (error) {
                    this.logRecoverableFailure("Render cache construction stopped", error);
                    break;
                }
                if (chunk === null || chunk.length === 0) {
                    break;
                }
                // Store a defensive copy - render() returns WASM memory that may be reused.
                // Clamp the final chunk so a cache never exceeds its configured memory
                // budget simply because the renderer returns a large buffer.
                const remaining = maxSamples - collected;
                const copy = chunk.subarray(0, remaining).slice();
                chunks.push(copy);
                collected += copy.length;
            }
            if (this.cacheToken !== token) {
                return;
            }
            // Combine all chunks into final cache buffer
            // Use single allocation instead of pool (this buffer lives for entire cache lifetime)
            const combined = new Int16Array(collected);
            let offset = 0;
            for (const chunk of chunks) {
                combined.set(chunk, offset);
                offset += chunk.length;
            }
            this.cachedPcm = combined;
            this.cacheSampleRate = this.sampleRate;
            this.cacheChannels = channels;
            this.cacheCursor = 0;
        }
        finally {
            this.releaseContext(ctx);
        }
    }
    cacheAvailable() {
        return (!!this.cachedPcm &&
            this.cacheSampleRate === this.sampleRate &&
            this.cacheChannels === (this.stereo ? 2 : 1));
    }
    /**
     * Clear cached data to free memory.
     * Call this when the engine instance is no longer needed.
     */
    dispose() {
        this.releaseContext(this.context);
        this.context = undefined;
        this.configured = false;
        this.resetCacheState();
        this.originalSidBuffer = null;
        // Null module references so the WASM linear-memory ArrayBuffer (~64–128 MB)
        // becomes GC-eligible immediately rather than being held until the engine
        // wrapper object is eventually collected.
        this.module = undefined;
        this.modulePromise = undefined;
    }
}
//# sourceMappingURL=player.js.map