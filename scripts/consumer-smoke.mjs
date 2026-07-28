/**
 * The consumer smoke test, shared by the pre-publish and post-publish gates.
 *
 * `check-package.mjs` runs it against the packed tarball before anything is
 * published; `published-smoke.mjs` runs it against the copy installed from the
 * registry afterwards. Both must be the same test, or "the bytes we verified"
 * and "the bytes users get" are checked to different standards.
 *
 * It is emitted as source rather than imported, because it has to execute inside
 * a scratch directory that resolves the package by name.
 */

/**
 * @param {object} options
 * @param {string} options.packageName  bare specifier the scratch project resolves
 * @param {string} [options.expectedVersion]  assert PACKAGE_VERSION, when known
 * @param {string} options.tunePath  SID file to render, relative to the scratch dir
 */
export function renderConsumerSmoke({ packageName, expectedVersion, tunePath }) {
  return `import { readFileSync } from "node:fs";
import {
  LIBRESIDFP_VERSION,
  LIBSIDPLAYFP_VERSION,
  PACKAGE_VERSION,
  SidAudioEngine,
  loadLibsidplayfp,
} from ${JSON.stringify(packageName)};

const tune = new Uint8Array(readFileSync(${JSON.stringify(tunePath)}));
const expectedVersion = ${JSON.stringify(expectedVersion ?? null)};

if (expectedVersion !== null && PACKAGE_VERSION !== expectedVersion) {
  throw new Error(\`PACKAGE_VERSION is \${PACKAGE_VERSION}, expected \${expectedVersion}\`);
}
for (const [label, value] of [
  ["LIBSIDPLAYFP_VERSION", LIBSIDPLAYFP_VERSION],
  ["LIBRESIDFP_VERSION", LIBRESIDFP_VERSION],
]) {
  if (!/^\\d+\\.\\d+\\.\\d+$/.test(value)) {
    throw new Error(\`\${label} is not a release version: \${value}\`);
  }
}
console.log(
  \`package \${PACKAGE_VERSION} contains libsidplayfp \${LIBSIDPLAYFP_VERSION}\` +
    \` and libresidfp \${LIBRESIDFP_VERSION}\`,
);

function rms(pcm) {
  let sum = 0;
  for (const sample of pcm) sum += (sample / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, pcm.length));
}

for (const [engine, builder] of [["sidlite", "WasmSIDLite"], ["residfp", "WasmReSIDfp"]]) {
  // The generated module, driven directly.
  const wasm = await loadLibsidplayfp({ engine });
  if (wasm.getSidEngineName() !== builder) {
    throw new Error(\`\${engine} resolved to \${wasm.getSidEngineName()}, expected \${builder}\`);
  }
  const context = new wasm.SidPlayerContext();
  try {
    if (!context.configure(48_000, true)) throw new Error(context.getLastError());
    if (!context.loadSidBuffer(tune)) throw new Error(context.getLastError());
    const chunk = context.render(100_000);
    if (!chunk || chunk.length === 0) throw new Error(\`\${engine} module produced no samples\`);
    if (!chunk.some((sample) => sample !== 0)) throw new Error(\`\${engine} module produced silence\`);
    const info = context.getEngineInfo();
    if (!info || info.builder !== builder) throw new Error(\`\${engine} reported the wrong builder\`);
    if (typeof context.getTuneMd5() !== "string") throw new Error(\`\${engine} has no MD5 binding\`);
  } finally {
    context.delete();
  }

  // The SidAudioEngine wrapper, which is what most callers use.
  const player = new SidAudioEngine({ engine, sampleRate: 44_100, stereo: true });
  try {
    await player.loadSidBuffer(tune);
    const pcm = await player.renderSeconds(1, 20_000);
    if (pcm.length !== 88_200) {
      throw new Error(\`\${engine} wrapper produced \${pcm.length} samples, expected 88200\`);
    }
    const level = rms(pcm);
    if (!(level > 0.001)) throw new Error(\`\${engine} wrapper rendered silence (rms \${level})\`);
    console.log(\`\${engine}: \${pcm.length} samples, rms \${level.toFixed(4)}\`);
  } finally {
    player.dispose();
  }
}

console.log("consumer smoke test: ok");
`;
}
