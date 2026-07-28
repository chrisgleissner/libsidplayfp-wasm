import { describe, expect, it } from "bun:test";

import { SonglengthDatabase } from "../src/songlengths.js";

/**
 * The parsing contract comes from libsidplayfp's own `SidDatabase.cpp`, so the
 * cases below are the ones that file's `parseTime` distinguishes — in
 * particular that the fractional part scales by digit count, which is the rule
 * most likely to be reimplemented wrongly.
 */
const MD5 = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

describe("SonglengthDatabase", () => {
    it("reads the section header, comments and blank lines without tripping", () => {
        const db = SonglengthDatabase.parse(
            ["[Database]", "; a comment", "", `${MD5}=1:02`, "   "].join("\n"),
        );

        expect(db.size).toBe(1);
        expect(db.lengthMs(MD5)).toBe(62_000);
    });

    it("scales the fraction by how many digits were written", () => {
        const db = SonglengthDatabase.parse(
            [`${MD5}=1:02 1:02.5 1:02.50 1:02.500 1:02.05 1:02.005`].join("\n"),
        );

        // ".5" is 500ms, not 5ms — the case a naive parseFloat would get right
        // by accident and a naive parseInt would get wrong.
        expect(db.lengthsMs(MD5)).toEqual([62_000, 62_500, 62_500, 62_500, 62_050, 62_005]);
    });

    it("ignores whatever follows a time up to the next space", () => {
        // HVSC annotates entries like this; upstream skips to the next space.
        const db = SonglengthDatabase.parse(`${MD5}=1:02(F) 0:30(E)`);

        expect(db.lengthsMs(MD5)).toEqual([62_000, 30_000]);
    });

    it("does not cap minutes at an hour", () => {
        const db = SonglengthDatabase.parse(`${MD5}=90:00`);

        expect(db.lengthSeconds(MD5)).toBe(5_400);
    });

    it("indexes songs from one, as libsidplayfp does", () => {
        const db = SonglengthDatabase.parse(`${MD5}=0:10 0:20 0:30`);

        expect(db.lengthMs(MD5, 1)).toBe(10_000);
        expect(db.lengthMs(MD5, 3)).toBe(30_000);
        expect(db.lengthMs(MD5)).toBe(10_000);
    });

    it("returns null rather than throwing for anything it cannot answer", () => {
        const db = SonglengthDatabase.parse(`${MD5}=0:10 0:20`);

        expect(db.lengthMs(OTHER)).toBeNull();
        expect(db.lengthSeconds(OTHER)).toBeNull();
        expect(db.lengthsMs(OTHER)).toBeNull();
        expect(db.lengthMs(MD5, 0)).toBeNull();
        expect(db.lengthMs(MD5, 3)).toBeNull();
        expect(db.lengthMs(MD5, 1.5)).toBeNull();
        expect(db.has(OTHER)).toBe(false);
        expect(db.has(MD5)).toBe(true);
    });

    it("matches MD5 keys regardless of case or surrounding space", () => {
        const db = SonglengthDatabase.parse(`  ${MD5.toUpperCase()}  =  1:00  `);

        expect(db.lengthMs(` ${MD5.toUpperCase()} `)).toBe(60_000);
        expect(db.lengthMs(MD5)).toBe(60_000);
    });

    /**
     * The file is a community-maintained list of tens of thousands of lines. One
     * malformed entry should cost that entry and nothing else — dropping the
     * whole database over it would be the worse failure.
     */
    it("skips malformed entries and keeps the rest", () => {
        const db = SonglengthDatabase.parse(
            [
                `${MD5}=1:00`,
                "not-an-md5=1:00",
                "=1:00",
                `${OTHER}=`,
                `${"a".repeat(31)}=1:00`,
                `${"b".repeat(32)}=not-a-time`,
                `${"c".repeat(32)}=1:00 garbage`,
                `${"d".repeat(32)}=1:00.9999`,
            ].join("\n"),
        );

        expect(db.size).toBe(1);
        expect(db.lengthMs(MD5)).toBe(60_000);
    });

    /**
     * Upstream commits to reading a fraction as soon as it sees the dot, and
     * treats "no digits after it" as a parse error rather than falling back to
     * the whole seconds. Accepting `1:00.` here would make this parser more
     * permissive than the library it mirrors.
     */
    it("rejects a dot with no fraction, as upstream does", () => {
        const db = SonglengthDatabase.parse(`${MD5}=1:00.`);

        expect(db.size).toBe(0);
    });

    it("reports an empty database for empty input", () => {
        expect(SonglengthDatabase.parse("").size).toBe(0);
    });

    it("keeps the last entry when a tune appears twice", () => {
        const db = SonglengthDatabase.parse([`${MD5}=1:00`, `${MD5}=2:00`].join("\n"));

        expect(db.lengthMs(MD5)).toBe(120_000);
    });

    it("reads files with carriage returns", () => {
        const db = SonglengthDatabase.parse(`[Database]\r\n${MD5}=1:00\r\n`);

        expect(db.lengthMs(MD5)).toBe(60_000);
    });
});
