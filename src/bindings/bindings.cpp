#include <algorithm>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <config.h>
#include <sidplayfp/sidplayfp.h>
#include <sidplayfp/SidConfig.h>
#include <sidplayfp/SidInfo.h>
#include <sidplayfp/SidTune.h>
#include <sidplayfp/SidTuneInfo.h>
#include <sidplayfp/sidbuilder.h>

#include <sidemu.h>

// reSIDfp requires libresidfp. Since libsidplayfp v3.x reSIDfp lives in an
// external library (configure.ac: PKG_CHECK_MODULES([RESIDFP], [libresidfp])),
// and HAVE_RESIDFP is defined only when pkg-config finds it. Without it,
// libsidplayfp falls back to SIDLite — which is a perfectly good emulation, but
// it would mean shipping an artifact that is not the engine it claims to be.
//
// Fail the build rather than let that happen by accident. To build SIDLite,
// ask for it: -DSIDFLOW_SID_ENGINE_SIDLITE.
#if !defined(HAVE_RESIDFP) && !defined(SIDFLOW_ALLOW_SIDLITE)
#error "libresidfp not found: this build would silently fall back to SIDLite. \
Build libresidfp into the emscripten sysroot so pkg-config defines HAVE_RESIDFP, \
or set SIDFLOW_ALLOW_SIDLITE=1 to deliberately build a SIDLite comparison artifact."
#endif

// Engine selection is explicit, not merely a fallback.
//
// SIDFLOW_ALLOW_SIDLITE means "tolerate the absence of reSIDfp".
// SIDFLOW_SID_ENGINE_SIDLITE selects SIDLite even when reSIDfp is available,
// which is what lets both artifacts be built from one tree and compared on
// equal terms.
#if defined(SIDFLOW_SID_ENGINE_SIDLITE)
#define SIDFLOW_USE_SIDLITE 1
#elif defined(HAVE_RESIDFP)
#define SIDFLOW_USE_SIDLITE 0
#else
#define SIDFLOW_USE_SIDLITE 1
#endif

#if SIDFLOW_USE_SIDLITE
#include <sidlite.h>
using DefaultSidBuilder = SIDLiteBuilder;
static constexpr const char *kDefaultBuilderName = "WasmSIDLite";
#else
#include <residfp.h>
using DefaultSidBuilder = ReSIDfpBuilder;
static constexpr const char *kDefaultBuilderName = "WasmReSIDfp";
#endif

static std::string sidEngineName()
{
    return kDefaultBuilderName;
}

namespace
{
    constexpr uint32_t kDefaultSampleRate = 44100;
    constexpr bool kDefaultStereo = true;

    // A player configured outside this range can never emit a sample, so reject
    // the rate rather than construct one.
    constexpr uint32_t kMinSampleRate = 4000;
    constexpr uint32_t kMaxSampleRate = 192000;

    /**
     * Upper bound on retained SID write records.
     *
     * Playback produces roughly 1 250 records per second, so a host that enables
     * tracing and never drains the buffer would walk the WASM heap up until the
     * runtime aborts. Records past the cap are dropped and counted, so such a
     * caller loses data rather than the process.
     */
    constexpr size_t kMaxSidWriteTraceRecords = 1u << 20; // 16 MiB of records

    struct SidWriteTraceRecord
    {
        uint32_t sidNumber;
        uint32_t address;
        uint32_t value;
        // PHI1 cycles at 985 248 Hz overflow uint32 after ~73 minutes of
        // playback. Keep the full width upstream hands us and narrow only at
        // the JS boundary, where a double represents it exactly.
        int64_t cyclePhi1;
    };

    emscripten::val makeEmptyInt16Array()
    {
        return emscripten::val::global("Int16Array").new_(0);
    }

    size_t extractLength(const emscripten::val &value)
    {
        if (value.isUndefined() || value.isNull())
        {
            return 0;
        }

        const emscripten::val lengthVal = value["length"];
        if (!lengthVal.isUndefined() && !lengthVal.isNull())
        {
            return lengthVal.as<size_t>();
        }

        const emscripten::val byteLengthVal = value["byteLength"];
        if (!byteLengthVal.isUndefined() && !byteLengthVal.isNull())
        {
            return byteLengthVal.as<size_t>();
        }

        return 0;
    }

    bool hasKey(const emscripten::val &options, const char *key)
    {
        if (options.isUndefined() || options.isNull())
        {
            return false;
        }
        const emscripten::val value = options[key];
        return !value.isUndefined() && !value.isNull();
    }

    // Enum values cross the boundary as strings. They read the same way in
    // JavaScript, in the .d.ts, and in a bug report, and unlike raw integers
    // they cannot silently shift if upstream reorders an enum.
    template <typename Enum, size_t N>
    bool readEnum(const emscripten::val &options, const char *key,
                  const std::pair<const char *, Enum> (&names)[N], Enum &target,
                  std::string &error)
    {
        if (!hasKey(options, key))
        {
            return true;
        }

        const std::string requested = options[key].as<std::string>();
        for (const auto &entry : names)
        {
            if (requested == entry.first)
            {
                target = entry.second;
                return true;
            }
        }

        error = std::string("unknown ") + key + ": " + requested;
        return false;
    }

    template <typename Enum, size_t N>
    const char *enumName(const std::pair<const char *, Enum> (&names)[N], Enum value)
    {
        for (const auto &entry : names)
        {
            if (entry.second == value)
            {
                return entry.first;
            }
        }
        return "";
    }

    constexpr std::pair<const char *, SidConfig::c64_model_t> kC64Models[] = {
        {"PAL", SidConfig::PAL},
        {"NTSC", SidConfig::NTSC},
        {"OLD_NTSC", SidConfig::OLD_NTSC},
        {"DREAN", SidConfig::DREAN},
        {"PAL_M", SidConfig::PAL_M},
    };

    constexpr std::pair<const char *, SidConfig::sid_model_t> kSidModels[] = {
        {"MOS6581", SidConfig::MOS6581},
        {"MOS8580", SidConfig::MOS8580},
    };

    constexpr std::pair<const char *, SidConfig::cia_model_t> kCiaModels[] = {
        {"MOS6526", SidConfig::MOS6526},
        {"MOS8521", SidConfig::MOS8521},
        {"MOS6526W4485", SidConfig::MOS6526W4485},
    };

    constexpr std::pair<const char *, SidConfig::sampling_method_t> kSamplingMethods[] = {
        {"INTERPOLATE", SidConfig::INTERPOLATE},
        {"RESAMPLE_INTERPOLATE", SidConfig::RESAMPLE_INTERPOLATE},
    };

    constexpr std::pair<const char *, SidConfig::sid_cw_t> kCombinedWaveforms[] = {
        {"AVERAGE", SidConfig::AVERAGE},
        {"WEAK", SidConfig::WEAK},
        {"STRONG", SidConfig::STRONG},
    };

    constexpr std::pair<const char *, SidTuneInfo::clock_t> kTuneClocks[] = {
        {"UNKNOWN", SidTuneInfo::CLOCK_UNKNOWN},
        {"PAL", SidTuneInfo::CLOCK_PAL},
        {"NTSC", SidTuneInfo::CLOCK_NTSC},
        {"ANY", SidTuneInfo::CLOCK_ANY},
    };

    constexpr std::pair<const char *, SidTuneInfo::model_t> kTuneSidModels[] = {
        {"UNKNOWN", SidTuneInfo::SIDMODEL_UNKNOWN},
        {"MOS6581", SidTuneInfo::SIDMODEL_6581},
        {"MOS8580", SidTuneInfo::SIDMODEL_8580},
        {"ANY", SidTuneInfo::SIDMODEL_ANY},
    };

    constexpr std::pair<const char *, SidTuneInfo::compatibility_t> kCompatibility[] = {
        {"C64", SidTuneInfo::COMPATIBILITY_C64},
        {"PSID", SidTuneInfo::COMPATIBILITY_PSID},
        {"R64", SidTuneInfo::COMPATIBILITY_R64},
        {"BASIC", SidTuneInfo::COMPATIBILITY_BASIC},
    };
}

// SID register write tracing.
//
// The builder hands out upstream's own emulation object untouched, so the audio
// path is byte-for-byte libsidplayfp's. Tracing is a nullable function pointer
// consulted inside the patched `sidemu::writeReg` (see
// scripts/apply-sid-write-hook.py), the single funnel every CPU SID register
// write already passes through. It observes and nothing else: with the hook
// unset, which is the default, the emulation is exactly upstream's.
//
// Wrapping `libsidplayfp::sidemu` to intercept writes does not work, and fails
// silently. `sidemu::bufferpos()` is not virtual, and player.cpp drives the
// consume cycle through it (`sampleCount = s->bufferpos(); s->bufferpos(0);`),
// so the reset would land on the wrapper while samples were produced into the
// inner emulation's buffer. The inner cursor would never be reset, would grow
// without bound, and would feed the mixer an ever-growing stale sample count.
extern "C" void (*sidflow_sid_write_hook)(const void *emu, unsigned int addr,
                                          unsigned int data, long long cyclePhi1) = nullptr;

class SidWriteTraceBuilder final : public DefaultSidBuilder
{
public:
    SidWriteTraceBuilder(const char *name, std::vector<SidWriteTraceRecord> *traceSink,
                         bool *traceEnabled, uint32_t *droppedTraces)
        : DefaultSidBuilder(name),
          traceSink(traceSink),
          traceEnabled(traceEnabled),
          droppedTraces(droppedTraces)
    {
    }

    ~SidWriteTraceBuilder() override
    {
        for (const auto &entry : sidNumbers)
        {
            registry().erase(entry.first);
        }
    }

    // SID numbers are assigned when the emulation is created and stay stable for
    // its lifetime, so they survive libsidplayfp reusing a chip from its pool
    // across reconfigurations. Nothing to reset beyond the trace buffer itself,
    // which the caller clears.
    void resetTraceState() {}

    void record(const void *emu, unsigned int addr, unsigned int data, long long cyclePhi1)
    {
        if (traceEnabled == nullptr || !*traceEnabled || traceSink == nullptr)
        {
            return;
        }

        if (traceSink->size() >= kMaxSidWriteTraceRecords)
        {
            if (droppedTraces != nullptr)
            {
                ++*droppedTraces;
            }
            return;
        }

        const auto known = sidNumbers.find(emu);
        traceSink->push_back(SidWriteTraceRecord{
            known != sidNumbers.end() ? known->second : 0u,
            static_cast<uint32_t>(addr & 0x1f),
            static_cast<uint32_t>(data),
            cyclePhi1,
        });
    }

    // Maps an emulation instance back to the builder that created it, so the
    // hook can attribute a write without the emulation knowing about tracing.
    static std::map<const void *, SidWriteTraceBuilder *> &registry()
    {
        static std::map<const void *, SidWriteTraceBuilder *> instance;
        return instance;
    }

protected:
    libsidplayfp::sidemu *create() override
    {
        libsidplayfp::sidemu *emu = DefaultSidBuilder::create();
        if (emu != nullptr)
        {
            // Assigning over any previous entry keeps this correct when the
            // allocator reuses the address of a removed emulation.
            sidNumbers[emu] = nextSidNumber++;
            registry()[emu] = this;
        }
        return emu;
    }

private:
    std::vector<SidWriteTraceRecord> *traceSink;
    bool *traceEnabled;
    uint32_t *droppedTraces;
    uint32_t nextSidNumber = 0;
    std::map<const void *, uint32_t> sidNumbers;
};

namespace
{
    void sidflowSidWriteHook(const void *emu, unsigned int addr, unsigned int data, long long cyclePhi1)
    {
        auto &registry = SidWriteTraceBuilder::registry();
        const auto owner = registry.find(emu);
        if (owner != registry.end())
        {
            owner->second->record(emu, addr, data, cyclePhi1);
        }
    }

    // The hook is installed only while something is actually tracing, so a
    // player that never asks for traces runs with the pointer null.
    unsigned int traceConsumers = 0;

    void retainWriteHook()
    {
        if (traceConsumers++ == 0)
        {
            sidflow_sid_write_hook = &sidflowSidWriteHook;
        }
    }

    void releaseWriteHook()
    {
        if (traceConsumers > 0 && --traceConsumers == 0)
        {
            sidflow_sid_write_hook = nullptr;
        }
    }
}

class SidPlayerContext
{
public:
    SidPlayerContext()
        : builder(std::make_unique<SidWriteTraceBuilder>(kDefaultBuilderName, &sidWriteTrace,
                                                         &traceEnabled, &droppedTraces)),
          stereo(kDefaultStereo),
          channels(kDefaultStereo ? 2u : 1u),
          sampleRate(kDefaultSampleRate),
          configured(false)
    {
        // Deterministic by default: libsidplayfp's own default power-on delay is
        // MAX + 1, which it reads as "randomise". Callers who want a specific
        // machine's power-on state can still ask for one through setEmulationConfig().
        emulationConfig.powerOnDelay = SidConfig::MAX_POWER_ON_DELAY;
        emulationConfig.samplingMethod = SidConfig::RESAMPLE_INTERPOLATE;
        emulationConfig.digiBoost = true;
        emulationConfig.frequency = kDefaultSampleRate;
    }

    ~SidPlayerContext()
    {
        // Balance the hook refcount so a context destroyed while tracing does
        // not leave the hook installed for players that never asked for it.
        if (traceEnabled)
        {
            releaseWriteHook();
        }
    }

    bool configure(uint32_t frequency, bool stereoPlayback)
    {
        if (frequency < kMinSampleRate || frequency > kMaxSampleRate)
        {
            lastError = "sample rate must be between " + std::to_string(kMinSampleRate) +
                        " and " + std::to_string(kMaxSampleRate) + " Hz";
            return false;
        }

        sampleRate = frequency;
        stereo = stereoPlayback;
        channels = stereo ? 2u : 1u;
        emulationConfig.frequency = sampleRate;
        return applyEmulationConfig();
    }

    /**
     * Set any subset of libsidplayfp's SidConfig from a JavaScript object.
     *
     * This is what lets a tune be rendered as an 8580, as NTSC, or with a
     * specific power-on state. Unspecified keys keep their current value, so it
     * composes with configure() in either order.
     */
    bool setEmulationConfig(emscripten::val options)
    {
        SidConfig candidate = emulationConfig;
        std::string error;

        if (!readEnum(options, "c64Model", kC64Models, candidate.defaultC64Model, error) ||
            !readEnum(options, "sidModel", kSidModels, candidate.defaultSidModel, error) ||
            !readEnum(options, "ciaModel", kCiaModels, candidate.ciaModel, error) ||
            !readEnum(options, "samplingMethod", kSamplingMethods, candidate.samplingMethod, error))
        {
            lastError = error;
            return false;
        }

        if (hasKey(options, "forceC64Model")) candidate.forceC64Model = options["forceC64Model"].as<bool>();
        if (hasKey(options, "forceSidModel")) candidate.forceSidModel = options["forceSidModel"].as<bool>();
        if (hasKey(options, "digiBoost")) candidate.digiBoost = options["digiBoost"].as<bool>();

        if (hasKey(options, "frequency"))
        {
            const double frequency = options["frequency"].as<double>();
            if (frequency < kMinSampleRate || frequency > kMaxSampleRate)
            {
                lastError = "frequency must be between " + std::to_string(kMinSampleRate) +
                            " and " + std::to_string(kMaxSampleRate) + " Hz";
                return false;
            }
            candidate.frequency = static_cast<uint_least32_t>(frequency);
        }

        if (hasKey(options, "powerOnDelay"))
        {
            const double delay = options["powerOnDelay"].as<double>();
            if (delay < 0 || delay > SidConfig::DEFAULT_POWER_ON_DELAY)
            {
                lastError = "powerOnDelay must be 0.." +
                            std::to_string(SidConfig::DEFAULT_POWER_ON_DELAY) +
                            " (values above MAX_POWER_ON_DELAY randomise)";
                return false;
            }
            candidate.powerOnDelay = static_cast<uint_least16_t>(delay);
        }

        if (!readSidAddress(options, "secondSidAddress", candidate.secondSidAddress) ||
            !readSidAddress(options, "thirdSidAddress", candidate.thirdSidAddress))
        {
            return false;
        }

        // Commit only if the player accepts it. Recording a configuration the
        // engine rejected would hand it to the next context created.
        const SidConfig previousConfig = emulationConfig;
        const uint32_t previousSampleRate = sampleRate;
        const bool previousStereo = stereo;

        emulationConfig = candidate;
        sampleRate = static_cast<uint32_t>(candidate.frequency);
        if (hasKey(options, "stereo"))
        {
            stereo = options["stereo"].as<bool>();
            channels = stereo ? 2u : 1u;
        }

        if (!applyEmulationConfig())
        {
            emulationConfig = previousConfig;
            sampleRate = previousSampleRate;
            stereo = previousStereo;
            channels = stereo ? 2u : 1u;
            return false;
        }
        return true;
    }

    emscripten::val getEmulationConfig() const
    {
        emscripten::val obj = emscripten::val::object();
        obj.set("frequency", static_cast<double>(emulationConfig.frequency));
        obj.set("stereo", stereo);
        obj.set("channels", channels);
        obj.set("c64Model", std::string(enumName(kC64Models, emulationConfig.defaultC64Model)));
        obj.set("forceC64Model", emulationConfig.forceC64Model);
        obj.set("sidModel", std::string(enumName(kSidModels, emulationConfig.defaultSidModel)));
        obj.set("forceSidModel", emulationConfig.forceSidModel);
        obj.set("ciaModel", std::string(enumName(kCiaModels, emulationConfig.ciaModel)));
        obj.set("samplingMethod", std::string(enumName(kSamplingMethods, emulationConfig.samplingMethod)));
        obj.set("digiBoost", emulationConfig.digiBoost);
        obj.set("powerOnDelay", static_cast<double>(emulationConfig.powerOnDelay));
        obj.set("secondSidAddress", static_cast<double>(emulationConfig.secondSidAddress));
        obj.set("thirdSidAddress", static_cast<double>(emulationConfig.thirdSidAddress));
        return obj;
    }

    /**
     * reSIDfp filter and waveform tuning.
     *
     * These are what make a 6581 sound like *a particular* 6581. SIDLite has no
     * equivalent, so the SIDLite artifact reports failure rather than pretending
     * to apply them.
     *
     * Scope differs per knob, and reSIDfp does not say so at its own API.
     * `filter6581Range` and `old6581Caps` reach `FilterModelConfig6581` — a
     * singleton — through static methods, so they apply to every SID instance
     * in this WASM module, including ones already created. The rest are set on
     * this builder's own chips.
     */
    bool setFilterConfig(emscripten::val options)
    {
#if SIDFLOW_USE_SIDLITE
        (void)options;
        lastError = "filter tuning requires the reSIDfp engine; this artifact is SIDLite";
        return false;
#else
        auto *residfp = static_cast<ReSIDfpBuilder *>(builder.get());
        if (residfp == nullptr)
        {
            lastError = "SID builder not initialized";
            return false;
        }

        // Every reSIDfp curve/range knob is documented as a 0.0..1.0 unit value.
        const auto readUnit = [&](const char *key, double &target) -> bool {
            const double value = options[key].as<double>();
            if (!(value >= 0.0 && value <= 1.0))
            {
                lastError = std::string(key) + " must be within 0.0..1.0";
                return false;
            }
            target = value;
            return true;
        };

        double value = 0.0;
        if (hasKey(options, "filter6581Curve"))
        {
            if (!readUnit("filter6581Curve", value)) return false;
            residfp->filter6581Curve(value);
        }
        if (hasKey(options, "filter6581Range"))
        {
            if (!readUnit("filter6581Range", value)) return false;
            residfp->filter6581Range(value);
        }
        if (hasKey(options, "filter8580Curve"))
        {
            if (!readUnit("filter8580Curve", value)) return false;
            residfp->filter8580Curve(value);
        }
        if (hasKey(options, "old6581Caps"))
        {
            residfp->enableOld6581caps(options["old6581Caps"].as<bool>());
        }
        if (hasKey(options, "combinedWaveforms"))
        {
            SidConfig::sid_cw_t strength = SidConfig::AVERAGE;
            std::string error;
            if (!readEnum(options, "combinedWaveforms", kCombinedWaveforms, strength, error))
            {
                lastError = error;
                return false;
            }
            residfp->combinedWaveformsStrength(strength);
        }

        // The builder applies these when a chip is (re)created, so a tune that is
        // already loaded needs a reset to hear them.
        if (tune && !player.reset())
        {
            lastError = player.error();
            return false;
        }
        return true;
#endif
    }

    bool supportsFilterConfig() const
    {
        return SIDFLOW_USE_SIDLITE == 0;
    }

    bool loadSidFile(const std::string &path)
    {
        tune = std::make_unique<SidTune>(path.c_str());
        if (!tune->getStatus())
        {
            lastError = tune->statusString();
            tune.reset();
            return false;
        }

        return finalizeTuneLoad();
    }

    bool loadSidBuffer(emscripten::val data)
    {
        const size_t length = extractLength(data);

        if (length == 0)
        {
            lastError = "Buffer length is zero";
            return false;
        }

        tuneBuffer.resize(length);
        emscripten::val view = emscripten::val(emscripten::typed_memory_view(length, tuneBuffer.data()));
        view.call<void>("set", data);

        tune = std::make_unique<SidTune>(tuneBuffer.data(), static_cast<uint32_t>(tuneBuffer.size()));
        if (!tune->getStatus())
        {
            lastError = tune->statusString();
            tune.reset();
            return false;
        }

        return finalizeTuneLoad();
    }

    /**
     * Select a subtune.
     *
     * Returns the 1-based subtune libsidplayfp actually selected, or 0 on
     * failure. Because 0 alone cannot distinguish "no tune loaded" from "load
     * failed" from a successful selection, lastError is cleared on success and
     * set on every failure, so hasError()/getLastError() separate the cases.
     */
    unsigned int selectSong(unsigned int song)
    {
        if (!tune)
        {
            lastError = "no tune loaded";
            return 0U;
        }

        const unsigned int selected = tune->selectSong(song);
        if (!player.load(tune.get()))
        {
            lastError = player.error();
            return 0U;
        }

        if (!player.reset())
        {
            lastError = player.error();
            return 0U;
        }

        // MUST come after load(). See refreshMixer().
        refreshMixer();

        clearSidWriteTrace();
        clearError();

        return selected;
    }

    /** Mute or unmute one voice (0..2) of one SID chip. */
    bool mute(unsigned int sidNum, unsigned int voice, bool enable)
    {
        if (!requireInstalledSid(sidNum))
        {
            return false;
        }
        if (voice > 2U)
        {
            lastError = "voice must be 0, 1 or 2";
            return false;
        }
        player.mute(sidNum, voice, enable);
        return true;
    }

    /** Enable or bypass one SID chip's analogue filter. */
    bool setFilterEnabled(unsigned int sidNum, bool enable)
    {
        if (!requireInstalledSid(sidNum))
        {
            return false;
        }
        player.filter(sidNum, enable);
        return true;
    }

    /** Elapsed emulated playback time, from libsidplayfp's own clock. */
    double getTimeMs() const
    {
        return static_cast<double>(player.timeMs());
    }

    double getTimeSeconds() const
    {
        return static_cast<double>(player.time());
    }

    /** CIA 1 timer A latch — the real playback rate of a CIA-timed tune. */
    double getCia1TimerA() const
    {
        return static_cast<double>(player.getCia1TimerA());
    }

    unsigned int getInstalledSids() const
    {
        return player.installedSIDs();
    }

    /** Samples one render(cycles) call would produce, for exact host buffering. */
    double getBufferSize(unsigned int cycles)
    {
        return static_cast<double>(player.getBufSize(cycles));
    }

    /**
     * Current contents of a SID chip's 32 registers.
     *
     * This is what every SID visualiser needs and what no amount of PCM can
     * recover. Returns a fresh Uint8Array, not a heap view: it is small, and a
     * visualiser polling it every frame must not have to reason about aliasing.
     */
    emscripten::val getSidStatus(unsigned int sidNum)
    {
        if (!requireInstalledSid(sidNum))
        {
            return emscripten::val::null();
        }

        uint8_t regs[32] = {0};
        if (!player.getSidStatus(sidNum, regs))
        {
            lastError = "SID " + std::to_string(sidNum) + " did not report its registers";
            return emscripten::val::null();
        }

        emscripten::val out = emscripten::val::global("Uint8Array").new_(32);
        out.call<void>("set", emscripten::val(emscripten::typed_memory_view(sizeof(regs), regs)));
        return out;
    }

    /**
     * The HVSC Songlengths.md5 key for the loaded tune.
     *
     * Without this a browser player cannot look up how long a subtune runs.
     * libsidplayfp bundles its own MD5 (src/libs/hashlib), so this works in a
     * --without-gcrypt build.
     */
    std::string getTuneMd5()
    {
        if (!tune)
        {
            lastError = "no tune loaded";
            return std::string();
        }

        char digest[SidTune::MD5_LENGTH + 1] = {0};
        const char *result = tune->createMD5New(digest);
        if (result == nullptr)
        {
            lastError = "could not compute the tune MD5";
            return std::string();
        }
        clearError();
        return std::string(result);
    }

    /**
     * Render up to `cycles` C64 cycles of audio.
     *
     * IMPORTANT: the returned Int16Array is a *view into WASM linear memory*, not
     * a copy. It is overwritten by the next render() on this context and is
     * detached outright if the heap grows. Consume or copy it before calling
     * anything else on this object. Zero-copy is deliberate — this is the hot
     * path — but it is a contract, so it is stated here, in the .d.ts, and in the
     * README rather than left to be discovered at runtime.
     *
     * `Player::play()` clamps internally to MAX_CYCLES (20 000), so one call
     * advances at most ~20 ms of PAL time regardless of what is requested.
     */
    emscripten::val render(unsigned int cycles)
    {
        if (!tune || !configured)
        {
            return emscripten::val::null();
        }

        const int produced = player.play(cycles);
        if (produced < 0)
        {
            lastError = player.error();
            return emscripten::val::null();
        }

        if (produced == 0)
        {
            return makeEmptyInt16Array();
        }

        const size_t requiredSamples = static_cast<size_t>(produced) * channels;
        if (mixBuffer.size() < requiredSamples)
        {
            mixBuffer.resize(requiredSamples);
        }

        const unsigned int written = player.mix(mixBuffer.data(), static_cast<unsigned int>(produced));
        if (written == 0)
        {
            return makeEmptyInt16Array();
        }

        // player.mix() returns the number of samples written, which already includes channel multiplication
        return emscripten::val(emscripten::typed_memory_view(static_cast<size_t>(written), mixBuffer.data()));
    }

    bool reset()
    {
        if (!player.reset())
        {
            lastError = player.error();
            return false;
        }
        clearSidWriteTrace();
        return true;
    }

    void setSidWriteTraceEnabled(bool enabled)
    {
        if (enabled == traceEnabled)
        {
            return;
        }

        traceEnabled = enabled;
        if (traceEnabled)
        {
            retainWriteHook();
        }
        else
        {
            releaseWriteHook();
            clearSidWriteTrace();
        }
    }

    emscripten::val getAndClearSidWriteTraces()
    {
        emscripten::val traces = emscripten::val::array();
        for (size_t index = 0; index < sidWriteTrace.size(); ++index)
        {
            const SidWriteTraceRecord &trace = sidWriteTrace[index];
            emscripten::val entry = emscripten::val::object();
            entry.set("sidNumber", trace.sidNumber);
            entry.set("address", trace.address);
            entry.set("value", trace.value);
            entry.set("cyclePhi1", static_cast<double>(trace.cyclePhi1));
            traces.set(index, entry);
        }
        clearSidWriteTrace();
        return traces;
    }

    /**
     * The same records as a flat Float64Array of
     * [sidNumber, address, value, cyclePhi1] quadruples.
     *
     * getAndClearSidWriteTraces() allocates one JS object and performs four
     * cross-boundary property writes per record. A minute of a typical tune is
     * ~75 000 records, so that is 300 000 individual writes. This variant is one
     * copy. Float64 rather than Uint32 because cyclePhi1 exceeds 2^32 after ~73
     * minutes of playback and a double holds it exactly.
     *
     * The returned array is a fresh copy, not a heap view.
     */
    emscripten::val getAndClearSidWriteTracesPacked()
    {
        const size_t count = sidWriteTrace.size();
        // Local, not a member: at the trace cap a member would retain 32 MiB for
        // the lifetime of the context after a single large drain.
        std::vector<double> packed(count * 4);
        for (size_t index = 0; index < count; ++index)
        {
            const SidWriteTraceRecord &trace = sidWriteTrace[index];
            packed[index * 4 + 0] = static_cast<double>(trace.sidNumber);
            packed[index * 4 + 1] = static_cast<double>(trace.address);
            packed[index * 4 + 2] = static_cast<double>(trace.value);
            packed[index * 4 + 3] = static_cast<double>(trace.cyclePhi1);
        }
        clearSidWriteTrace();

        emscripten::val out = emscripten::val::global("Float64Array").new_(packed.size());
        if (!packed.empty())
        {
            out.call<void>("set", emscripten::val(emscripten::typed_memory_view(
                                      packed.size(), packed.data())));
        }
        return out;
    }

    /** Records discarded because the trace buffer hit its cap since the last drain. */
    double getDroppedSidWriteTraceCount() const
    {
        return static_cast<double>(droppedTraces);
    }

    bool hasError() const
    {
        return !lastError.empty();
    }

    void clearError()
    {
        lastError.clear();
    }

    bool hasTune() const
    {
        return static_cast<bool>(tune);
    }

    bool isStereo() const
    {
        return stereo;
    }

    unsigned int getChannels() const
    {
        return channels;
    }

    uint32_t getSampleRate() const
    {
        return sampleRate;
    }

    std::string getLastError() const
    {
        return lastError;
    }

    emscripten::val getTuneInfo() const
    {
        if (!tune)
        {
            return emscripten::val::null();
        }

        const SidTuneInfo *info = tune->getInfo();
        if (!info)
        {
            return emscripten::val::null();
        }

        emscripten::val obj = emscripten::val::object();
        obj.set("songs", info->songs());
        obj.set("startSong", info->startSong());
        obj.set("currentSong", info->currentSong());
        obj.set("loadAddress", info->loadAddr());
        obj.set("initAddress", info->initAddr());
        obj.set("playAddress", info->playAddr());
        obj.set("dataFileLen", info->dataFileLen());
        // Populated only when the tune came from loadSidFile; a tune read from a
        // buffer has no name or directory of its own. Empty string, not null, so
        // the field's type does not change with how the tune was loaded.
        obj.set("dataFileName", info->dataFileName() ? info->dataFileName() : "");
        obj.set("infoFileName", info->infoFileName() ? info->infoFileName() : "");
        obj.set("path", info->path() ? info->path() : "");
        obj.set("c64dataLen", info->c64dataLen());
        // Kept as the raw enum ordinal for backwards compatibility; clock is the
        // readable spelling and is what new code should use.
        obj.set("clockSpeed", static_cast<int>(info->clockSpeed()));
        obj.set("clock", std::string(enumName(kTuneClocks, info->clockSpeed())));
        obj.set("format", info->formatString() ? info->formatString() : "");
        obj.set("compatibility", std::string(enumName(kCompatibility, info->compatibility())));
        obj.set("songSpeed", info->songSpeed());
        obj.set("relocStartPage", info->relocStartPage());
        obj.set("relocPages", info->relocPages());
        obj.set("fixLoad", info->fixLoad());

        const int sidChips = info->sidChips();
        obj.set("sidChips", sidChips);

        emscripten::val chipBases = emscripten::val::array();
        emscripten::val chipModels = emscripten::val::array();
        for (int i = 0; i < sidChips; ++i)
        {
            const unsigned int index = static_cast<unsigned int>(i);
            chipBases.set(i, info->sidChipBase(index));
            chipModels.set(i, std::string(enumName(kTuneSidModels, info->sidModel(index))));
        }
        obj.set("sidChipBases", chipBases);
        obj.set("sidModels", chipModels);

        emscripten::val infoStrings = emscripten::val::array();
        const unsigned int infoCount = info->numberOfInfoStrings();
        for (unsigned int i = 0; i < infoCount; ++i)
        {
            const char *str = info->infoString(i);
            infoStrings.set(i, str ? str : "");
        }
        obj.set("infoStrings", infoStrings);

        emscripten::val commentStrings = emscripten::val::array();
        const unsigned int commentCount = info->numberOfCommentStrings();
        for (unsigned int i = 0; i < commentCount; ++i)
        {
            const char *str = info->commentString(i);
            commentStrings.set(i, str ? str : "");
        }
        obj.set("commentStrings", commentStrings);

        return obj;
    }

    emscripten::val getEngineInfo() const
    {
        const SidInfo &info = player.info();
        emscripten::val obj = emscripten::val::object();
        obj.set("name", info.name() ? info.name() : "");
        obj.set("version", info.version() ? info.version() : "");
        // SidInfo::channels() was removed in v3.0.0; the channel count is now
        // decided by the mixer, which we configure from `stereo`.
        obj.set("channels", channels);
        obj.set("driverAddress", info.driverAddr());
        obj.set("driverLength", info.driverLength());
        obj.set("powerOnDelay", info.powerOnDelay());
        obj.set("speed", info.speedString() ? info.speedString() : "");

        emscripten::val creditsArray = emscripten::val::array();
        const unsigned int creditsCount = info.numberOfCredits();
        for (unsigned int i = 0; i < creditsCount; ++i)
        {
            const char *credit = info.credits(i);
            creditsArray.set(i, credit ? credit : "");
        }
        obj.set("credits", creditsArray);

        obj.set("kernal", info.kernalDesc() ? info.kernalDesc() : "");
        obj.set("basic", info.basicDesc() ? info.basicDesc() : "");
        obj.set("chargen", info.chargenDesc() ? info.chargenDesc() : "");

        const unsigned int sidCount = info.numberOfSIDs();
        obj.set("sidChips", sidCount);
        obj.set("installedSids", player.installedSIDs());

        emscripten::val chipModels = emscripten::val::array();
        for (unsigned int i = 0; i < sidCount; ++i)
        {
            chipModels.set(i, std::string(enumName(kTuneSidModels, info.sidModel(i))));
        }
        obj.set("sidModels", chipModels);

        obj.set("builder", std::string(kDefaultBuilderName));
        obj.set("supportsFilterConfig", supportsFilterConfig());

        return obj;
    }

    bool setSystemROMs(emscripten::val kernal, emscripten::val basic, emscripten::val chargen)
    {
        const auto copyRom = [&](emscripten::val src, std::vector<uint8_t> &target, size_t expectedSize, const char *name) -> bool
        {
            if (src.isUndefined() || src.isNull())
            {
                target.clear();
                return true;
            }

            const size_t length = extractLength(src);
            if (length == 0)
            {
                lastError = std::string(name) + " buffer length is zero";
                return false;
            }

            if ((expectedSize != 0) && (length != expectedSize))
            {
                lastError = std::string(name) + " buffer expected " + std::to_string(expectedSize) + " bytes";
                return false;
            }

            target.resize(length);
            emscripten::val view = emscripten::val(emscripten::typed_memory_view(length, target.data()));
            view.call<void>("set", src);
            return true;
        };

        if (!copyRom(kernal, kernalRom, 8192, "KERNAL ROM"))
        {
            return false;
        }
        if (!copyRom(basic, basicRom, 8192, "BASIC ROM"))
        {
            return false;
        }
        if (!copyRom(chargen, chargenRom, 4096, "CHARGEN ROM"))
        {
            return false;
        }

        const uint8_t *kernalPtr = kernalRom.empty() ? nullptr : kernalRom.data();
        const uint8_t *basicPtr = basicRom.empty() ? nullptr : basicRom.data();
        const uint8_t *chargenPtr = chargenRom.empty() ? nullptr : chargenRom.data();

        player.setRoms(kernalPtr, basicPtr, chargenPtr);

        if (tune)
        {
            if (!player.reset())
            {
                lastError = player.error();
                return false;
            }

            refreshMixer();
        }

        return true;
    }

private:
    /**
     * Re-point the mixer at the SID chips' sample buffers.
     *
     * This must be called after *every* player.config() or player.load(), and
     * getting it wrong is silent and destructive. sidplayfp::initMixer() caches
     * each chip's raw `short*` (player.cpp: `buffers[i] = m_chips[i]->buffer()`),
     * while player.load() re-runs config() ("Must re-configure on fly for stereo
     * support!"), which reaches reSIDfpEmu::sampling() and does
     * `delete[] m_buffer; m_buffer = new short[...]`. Any mixer initialised
     * before that point is left holding freed pointers, and every subsequent
     * mix() reads freed memory.
     *
     * The failure mode is a heap-use-after-free reading a 1920-byte region —
     * exactly `new short[960]`, the 20 ms buffer for 48 kHz. It sounds like an
     * engine playing the right notes at the right time with ~10 dB of excess
     * high frequency, and its output changes with the render chunk size, because
     * the contents of the freed region depend on allocator activity.
     */
    void refreshMixer()
    {
        if (player.installedSIDs() > 0U)
        {
            player.initMixer(stereo);
        }
    }

    /**
     * Push `emulationConfig` into the player and re-point the mixer.
     *
     * Every path that changes emulation settings funnels through here so the
     * builder pointer, the trace reset, and the post-config initMixer() cannot
     * be forgotten at one call site and remembered at another.
     */
    bool applyEmulationConfig()
    {
        if (!builder)
        {
            lastError = "SID builder not initialized";
            return false;
        }

        SidConfig cfg = emulationConfig;
        // Since v3.0.0 stereo is purely a mixer concern (SidConfig::playback and
        // MONO/STEREO were removed); initMixer(stereo) below selects it.
        cfg.sidEmulation = builder.get();

        builder->resetTraceState();
        clearSidWriteTrace();

        if (!player.config(cfg))
        {
            lastError = player.error();
            configured = false;
            return false;
        }

        refreshMixer();
        configured = true;
        clearError();
        return true;
    }

    bool readSidAddress(const emscripten::val &options, const char *key, uint_least16_t &target)
    {
        if (!hasKey(options, key))
        {
            return true;
        }
        const double address = options[key].as<double>();
        // 0 disables the extra chip; otherwise it must be a real 16-bit I/O address.
        if (address < 0 || address > 0xffff)
        {
            lastError = std::string(key) + " must be a 16-bit address, or 0 to disable";
            return false;
        }
        target = static_cast<uint_least16_t>(address);
        return true;
    }

    bool requireInstalledSid(unsigned int sidNum)
    {
        const unsigned int installed = player.installedSIDs();
        if (installed == 0U)
        {
            lastError = "no SID chips are installed; load a tune first";
            return false;
        }
        if (sidNum >= installed)
        {
            lastError = "SID " + std::to_string(sidNum) + " is out of range; " +
                        std::to_string(installed) + " installed";
            return false;
        }
        return true;
    }

    void clearSidWriteTrace()
    {
        sidWriteTrace.clear();
        droppedTraces = 0;
    }

    bool finalizeTuneLoad()
    {
        if (!configured && !applyEmulationConfig())
        {
            return false;
        }

        tune->selectSong(0);

        builder->resetTraceState();
        clearSidWriteTrace();

        if (!player.load(tune.get()))
        {
            lastError = player.error();
            tune.reset();
            return false;
        }

        if (!player.reset())
        {
            lastError = player.error();
            return false;
        }

        refreshMixer();

        return true;
    }

    sidplayfp player;
    std::unique_ptr<SidWriteTraceBuilder> builder;
    std::unique_ptr<SidTune> tune;
    std::vector<uint8_t> tuneBuffer;
    std::vector<int16_t> mixBuffer;
    std::vector<uint8_t> kernalRom;
    std::vector<uint8_t> basicRom;
    std::vector<uint8_t> chargenRom;
    SidConfig emulationConfig;
    bool stereo;
    unsigned int channels;
    uint32_t sampleRate;
    bool configured;
    bool traceEnabled = false;
    uint32_t droppedTraces = 0;
    std::string lastError;
    std::vector<SidWriteTraceRecord> sidWriteTrace;
};

EMSCRIPTEN_BINDINGS(libsidplayfp_wasm)
{
    // Free function so a caller can ask which engine this artifact was built
    // with before constructing anything. Grepping the .wasm for the builder
    // name also works, but only from a filesystem that has the artifact.
    emscripten::function("getSidEngineName", &sidEngineName);

    emscripten::class_<SidPlayerContext>("SidPlayerContext")
        .constructor<>()
        .function("configure", &SidPlayerContext::configure)
        .function("setEmulationConfig", &SidPlayerContext::setEmulationConfig)
        .function("getEmulationConfig", &SidPlayerContext::getEmulationConfig)
        .function("setFilterConfig", &SidPlayerContext::setFilterConfig)
        .function("supportsFilterConfig", &SidPlayerContext::supportsFilterConfig)
        .function("loadSidFile", &SidPlayerContext::loadSidFile)
        .function("loadSidBuffer", &SidPlayerContext::loadSidBuffer)
        .function("selectSong", &SidPlayerContext::selectSong)
        .function("render", &SidPlayerContext::render)
        .function("reset", &SidPlayerContext::reset)
        .function("mute", &SidPlayerContext::mute)
        .function("setFilterEnabled", &SidPlayerContext::setFilterEnabled)
        .function("getTimeMs", &SidPlayerContext::getTimeMs)
        .function("getTimeSeconds", &SidPlayerContext::getTimeSeconds)
        .function("getCia1TimerA", &SidPlayerContext::getCia1TimerA)
        .function("getInstalledSids", &SidPlayerContext::getInstalledSids)
        .function("getBufferSize", &SidPlayerContext::getBufferSize)
        .function("getSidStatus", &SidPlayerContext::getSidStatus)
        .function("getTuneMd5", &SidPlayerContext::getTuneMd5)
        .function("setSidWriteTraceEnabled", &SidPlayerContext::setSidWriteTraceEnabled)
        .function("getAndClearSidWriteTraces", &SidPlayerContext::getAndClearSidWriteTraces)
        .function("getAndClearSidWriteTracesPacked", &SidPlayerContext::getAndClearSidWriteTracesPacked)
        .function("getDroppedSidWriteTraceCount", &SidPlayerContext::getDroppedSidWriteTraceCount)
        .function("hasTune", &SidPlayerContext::hasTune)
        .function("isStereo", &SidPlayerContext::isStereo)
        .function("getChannels", &SidPlayerContext::getChannels)
        .function("getSampleRate", &SidPlayerContext::getSampleRate)
        .function("getLastError", &SidPlayerContext::getLastError)
        .function("hasError", &SidPlayerContext::hasError)
        .function("clearError", &SidPlayerContext::clearError)
        .function("getTuneInfo", &SidPlayerContext::getTuneInfo)
        .function("getEngineInfo", &SidPlayerContext::getEngineInfo)
        .function("setSystemROMs", &SidPlayerContext::setSystemROMs);
}
