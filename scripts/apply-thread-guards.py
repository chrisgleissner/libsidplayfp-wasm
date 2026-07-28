#!/usr/bin/env python3
"""Make FilterModelConfig's helper threads run inline under emscripten.

reSIDfp builds its filter lookup tables in parallel:

    #ifdef HAVE_JTHREADS
        using sidThread = std::jthread;
    #else
        using sidThread = std::thread;
    #endif

        sidThread thdSummer(filterSummer);
        ... one per table ...

Emscripten's runtime here is single-threaded, so constructing those throws
`std::system_error: thread constructor failed: Not supported` the first time a
tune is loaded — the engine never produces a sample.

Rather than rewrite each construction site, this retargets the `sidThread`
alias itself at a shim that runs the callable inline. Construction and join
sites stay exactly as upstream wrote them, so the patch survives upstream
adding, removing or reordering table builders.

The location and the guard marker both move between upstream releases: as of
libsidplayfp v3.x reSIDfp is the external libresidfp library and the marker is
`HAVE_JTHREADS`, where earlier versions had these sources under
libsidplayfp's src/builders/ behind
`#if defined(HAVE_CXX20) && defined(__cpp_lib_jthread)`. This script therefore
searches the whole tree and, crucially, **fails when it finds thread usage it
could not neutralise** instead of reporting success: a silent skip would ship a
threaded build that cannot start.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys
from typing import List

# Declared at namespace scope: the alias site is inside a function body, and a
# local class may not have member templates.
# GPL-2.0 section 2(a) requires a modified file to say that it was changed and
# when. This notice is inserted into the upstream source inside the build
# container; see MODIFICATIONS.md in the libsidplayfp-wasm repository.
SHIM_DECLARATION = """
#if defined(__EMSCRIPTEN__)
// --- MODIFIED by the libsidplayfp-wasm project on 2026-07-28 --------------
// This file is not upstream as released: the sidThread alias below has been
// retargeted so filter-table builders run inline.
// See https://github.com/chrisgleissner/libsidplayfp-wasm (MODIFICATIONS.md).
//
// Emscripten's runtime here is single-threaded, so constructing a std::thread
// throws "thread constructor failed: Not supported" and the filter tables are
// never built. Running each builder inline on construction keeps upstream's
// construction and join sites untouched, so the same tables are produced.
namespace
{
    struct SidflowInlineThread
    {
        template <typename Callable>
        explicit SidflowInlineThread(Callable &&callable) { callable(); }
        void join() const {}
    };
}
#endif
"""

SHIM_ALIAS = """#if defined(__EMSCRIPTEN__)
    using sidThread = SidflowInlineThread;
#el"""

INCLUDE_LINE = re.compile(r"^\s*#\s*include\s*[<\"][^>\"]+[>\"].*$", re.MULTILINE)

# The alias-selection block: an #if/#ifdef whose body picks `using sidThread`,
# through to its closing #endif. Matched non-greedily so a later block in the
# same file is not swallowed.
SELECTION_BLOCK = re.compile(
    r"^[ \t]*#(?:if|ifdef)\b[^\n]*\n"  # opening conditional
    r"(?:(?!^[ \t]*#endif)[\s\S])*?"  # body, no #endif yet
    r"using\s+sidThread\s*=[^\n]*\n"  # ... which defines the alias
    r"(?:(?!^[ \t]*#endif)[\s\S])*?"  # rest of body
    r"^[ \t]*#endif[^\n]*\n",  # closing
    re.MULTILINE,
)

UNGUARDED_THREAD = re.compile(r"\bstd::j?thread\b")


def patch_file(path: pathlib.Path) -> bool:
    contents = path.read_text()

    if "SidflowInlineThread" in contents:
        return False  # already patched; idempotent

    if "sidThread" not in contents:
        return False

    match = SELECTION_BLOCK.search(contents)
    if not match:
        raise RuntimeError(
            "found `sidThread` but not the #if/#endif block that defines it; "
            "upstream restructured the alias — re-derive this patch"
        )

    block = match.group(0)
    # Turn the existing conditional into the `#elif` arm of the new guard.
    # `#elifdef` would be shorter but is C++23-only, and this has to keep
    # compiling if the standard level is ever lowered.
    first_line, rest = block.lstrip().split("\n", 1)
    directive = first_line.strip()
    if directive.startswith("#ifdef"):
        condition = f"defined({directive[len('#ifdef'):].strip()})"
    elif directive.startswith("#ifndef"):
        condition = f"!defined({directive[len('#ifndef'):].strip()})"
    else:
        condition = directive[len("#if") :].strip()

    contents = contents[: match.start()] + SHIM_ALIAS + f"if {condition}\n" + rest + contents[match.end() :]

    includes = list(INCLUDE_LINE.finditer(contents))
    if not includes:
        raise RuntimeError("no #include found to anchor the inline-thread shim")
    anchor = includes[-1].end()
    contents = contents[:anchor] + "\n" + SHIM_DECLARATION + contents[anchor:]

    path.write_text(contents)
    return True


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=pathlib.Path, help="Path to the source tree to patch")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    targets = sorted(root.glob("**/FilterModelConfig*.cpp"))

    patched = []
    for path in targets:
        try:
            if patch_file(path):
                patched.append(path)
        except Exception as exc:
            print(f"thread-guards: failed to update {path.relative_to(root)}: {exc}", file=sys.stderr)
            return 1

    for path in patched:
        print(f"thread-guards: sidThread runs inline in {path.relative_to(root)}")

    # A silent "nothing to do" would ship a threaded artifact that throws on the
    # first tune load, so verify the result instead of trusting the search.
    leftovers = []
    for path in root.glob("**/*.cpp"):
        text = path.read_text(errors="ignore")
        if not UNGUARDED_THREAD.search(text):
            continue
        if "__EMSCRIPTEN__" in text:
            continue
        leftovers.append(path.relative_to(root))

    if leftovers:
        print(
            "thread-guards: these sources still construct std::thread with no "
            "__EMSCRIPTEN__ guard, which fails at runtime in a single-threaded "
            "wasm runtime:\n  " + "\n  ".join(str(p) for p in leftovers),
            file=sys.stderr,
        )
        return 1

    if not patched:
        print("thread-guards: no thread usage needing guards in this tree")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main(sys.argv[1:]))
