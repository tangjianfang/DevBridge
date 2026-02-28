// scripts/release.mjs
// DevBridge release assembly script.
//
// Steps:
//   1. Clean dist/
//   2. Build frontend  (vite)       → packages/frontend/dist/
//   3. Bundle server   (esbuild)    → packages/server/dist/server.cjs
//   4. Copy frontend → dist/public/
//   5. Package with @yao-pkg/pkg    → release/devbridge-win-x64.exe
//   6. Copy native .node binaries   → release/
//
// Usage:
//   node scripts/release.mjs            # full build
//   node scripts/release.mjs --skip-fe  # skip frontend (faster iteration)

import { execSync }  from 'node:child_process';
import fs            from 'node:fs';
import path          from 'node:path';
import url           from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const DIST      = path.join(ROOT, 'dist');
const RELEASE   = path.join(ROOT, 'release');

const args      = process.argv.slice(2);
const skipFe    = args.includes('--skip-fe');

// ── Helpers ───────────────────────────────────────────────────────────────────

function run(cmd, cwd = ROOT) {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
}

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`  copied  ${path.relative(ROOT, src)}  →  ${path.relative(ROOT, dest)}`);
}

function rmrf(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`  removed ${path.relative(ROOT, dir)}`);
  }
}

// ── Step 0: Clean ─────────────────────────────────────────────────────────────

console.log('\n── Step 0: Clean ────────────────────────────────────────────────');
rmrf(DIST);
rmrf(RELEASE);
fs.mkdirSync(DIST,    { recursive: true });
fs.mkdirSync(RELEASE, { recursive: true });

// ── Step 1: Build shared types ────────────────────────────────────────────────

console.log('\n── Step 1: Build shared ─────────────────────────────────────────');
run('pnpm --filter @devbridge/shared run build');

// ── Step 2: Build frontend ────────────────────────────────────────────────────

if (!skipFe) {
  console.log('\n── Step 2: Build frontend ───────────────────────────────────────');
  run('pnpm --filter @devbridge/frontend run build');
} else {
  console.log('\n── Step 2: Skipped (--skip-fe) ──────────────────────────────────');
}

// ── Step 3: Bundle server (esbuild) ───────────────────────────────────────────

console.log('\n── Step 3: Bundle server ────────────────────────────────────────');
run('node packages/server/scripts/build.mjs');

// ── Step 4: Copy frontend assets → dist/public ───────────────────────────────

console.log('\n── Step 4: Copy frontend → dist/public ──────────────────────────');
const frontendDist = path.join(ROOT, 'packages', 'frontend', 'dist');
const publicDest   = path.join(DIST, 'public');

if (!skipFe && fs.existsSync(frontendDist)) {
  copy(frontendDist, publicDest);
} else if (!skipFe) {
  console.warn('  ⚠ Frontend dist not found – skipping static assets');
}

// ── Step 5: Write pkg config ──────────────────────────────────────────────────

console.log('\n── Step 5: Generate pkg config ──────────────────────────────────');

const pkgConfig = {
  name:    'devbridge',
  version: '0.1.0-beta.1',
  bin:     './dist/server.cjs',
  pkg: {
    assets: [
      'dist/public/**/*',
    ],
    scripts:  [],
    targets:  ['node20-win-x64'],
    outputPath: 'release',
  },
};

const pkgConfigPath = path.join(ROOT, 'pkg.config.json');
fs.writeFileSync(pkgConfigPath, JSON.stringify(pkgConfig, null, 2));
console.log(`  wrote   ${path.relative(ROOT, pkgConfigPath)}`);

// ── Step 6: Run pkg ───────────────────────────────────────────────────────────

console.log('\n── Step 6: Package with @yao-pkg/pkg ───────────────────────────');
run('npx --yes @yao-pkg/pkg dist/server.cjs --target node20-win-x64 --output release/devbridge.exe');

// ── Step 7: Copy native bindings alongside exe ────────────────────────────────

console.log('\n── Step 7: Copy native .node modules → release/ ─────────────────');

const nativeModules = [
  'node_modules/node-hid/build/Release/HID.node',
  'node_modules/node-hid/build/Release/HID_hidraw.node',
  'node_modules/@serialport/bindings-cpp/build/Release/bindings.node',
  'node_modules/usb/build/Release/usb_bindings.node',
];

for (const modPath of nativeModules) {
  const src = path.join(ROOT, modPath);
  if (fs.existsSync(src)) {
    const dest = path.join(RELEASE, path.basename(src));
    fs.copyFileSync(src, dest);
    console.log(`  copied  ${path.basename(src)}`);
  } else {
    console.log(`  skip    ${path.basename(src)} (optional — not installed)`);
  }
}

// ── Done ──────────────────────────────────────────────────────────────────────

const exePath = path.join(RELEASE, 'devbridge.exe');
const sizeMb  = fs.existsSync(exePath)
  ? (fs.statSync(exePath).size / 1024 / 1024).toFixed(1)
  : '?';

console.log(`
────────────────────────────────────────────────────────────
  ✓  Build complete

  EXE  release/devbridge.exe   (${sizeMb} MB)
  Run  release\\devbridge.exe
────────────────────────────────────────────────────────────
`);
