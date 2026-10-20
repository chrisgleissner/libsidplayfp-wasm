#!/usr/bin/env python3
"""Grow SIDLite's sample buffer before clocks and refresh the mixer's pointers.

Player::play counts scheduler events, not elapsed cycles. A fixed 20 ms buffer
can overflow even at the documented maximum pull. Every SID read/write clocks
the chip too, so the capacity check belongs in SIDLiteEmu::clock itself.
"""
import sys
from pathlib import Path

root = Path(sys.argv[1])
notice = "// Modified by libsidplayfp-wasm on 2026-10-20: SIDLite buffer capacity guards.\n"


def patch(relative: str, replacements: list[tuple[str, str]]) -> None:
    source = root / relative
    text = source.read_text()
    if notice in text:
        return
    for before, after in replacements:
        if text.count(before) != 1:
            raise SystemExit(f"SIDLite capacity patch anchor changed: {source}: {before!r}")
        text = text.replace(before, after, 1)
    source.write_text(notice + text)


patch("src/builders/sidlite-builder/sidlite-emu.h", [
    ("#include <cstdint>", "#include <cstdint>\n#include <cstddef>"),
    ("    SIDLite::SID &m_sid;", "    SIDLite::SID &m_sid;\n    std::size_t m_bufferCapacity = 0;"),
])
patch("src/builders/sidlite-builder/sidlite-emu.cpp", [
    ("#include <cmath>", "#include <cmath>\n#include <algorithm>\n#include <memory>"),
    ("    m_bufferpos += m_sid.clock(cycles, m_buffer+m_bufferpos);", """    // C64 clocks exceed every supported SIDLite sample rate. At most one
    // sample per elapsed cycle, plus a carried sample, is a conservative bound
    // independent of fractional rounding and the spacing of SID reads/writes.
    const std::size_t required = std::size_t(m_bufferpos) + std::size_t(cycles) + 1;
    if (required > m_bufferCapacity)
    {
        const std::size_t capacity = std::max(required, m_bufferCapacity * 2);
        std::unique_ptr<short[]> next(new short[capacity]);
        std::copy_n(m_buffer, m_bufferpos, next.get());
        delete[] m_buffer;
        m_buffer = next.release();
        m_bufferCapacity = capacity;
    }
    m_bufferpos += m_sid.clock(cycles, m_buffer+m_bufferpos);"""),
    ("    m_buffer = new short[buffersize];", "    m_buffer = new short[buffersize];\n    m_bufferCapacity = buffersize;"),
])
patch("src/simpleMixer.h", [
    ("    unsigned int doMix(short *buffer, unsigned int samples);", """    unsigned int doMix(short *buffer, unsigned int samples);

    // A SID builder can grow its sample allocation while the C64 runs.
    void setBuffer(unsigned int chip, short *buffer) { m_buffers[chip] = buffer; }"""),
])
patch("src/player.cpp", [
    ("    return m_simpleMixer->doMix(buffer, samples);", """    // SIDLite may have grown a buffer in play(), including inside SID writes.
    // Refresh before mixing so no cached pointer can refer to freed storage.
    for (unsigned int i = 0; i < m_chips.size(); ++i)
        m_simpleMixer->setBuffer(i, m_chips[i]->buffer());
    return m_simpleMixer->doMix(buffer, samples);"""),
])
