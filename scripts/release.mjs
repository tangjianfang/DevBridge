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

// Version resolution:
//   CI  → DEVBRIDGE_VERSION env var (e.g. "0.1.0-beta.12")
//   Local → base from package.json + auto-incrementing .build-number file
const pkgVersion  = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
let VERSION;
if (process.env.DEVBRIDGE_VERSION) {
  VERSION = process.env.DEVBRIDGE_VERSION;
} else {
  const buildNumFile = path.join(ROOT, '.build-number');
  const buildNum = fs.existsSync(buildNumFile)
    ? parseInt(fs.readFileSync(buildNumFile, 'utf8').trim(), 10) + 1
    : 1;
  fs.writeFileSync(buildNumFile, String(buildNum));
  // Strip trailing numeric segment from base version so we always control the suffix
  // e.g. "0.1.0-beta.1" -> "0.1.0-beta" + ".{buildNum}"
  const baseVersion = pkgVersion.replace(/\.\d+$/, '');
  VERSION = `${baseVersion}.${buildNum}`;
}
console.log(`  version ${VERSION}`);

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

// Copy server bundle to root dist/ so pkg can find it
const serverBundle = path.join(ROOT, 'packages', 'server', 'dist', 'server.cjs');
const serverDest   = path.join(DIST, 'server.cjs');
copy(serverBundle, serverDest);

// ── Step 4: Copy frontend assets → dist/public ───────────────────────────────

console.log('\n── Step 4: Copy frontend → dist/public ──────────────────────────');
const frontendDist = path.join(ROOT, 'packages', 'frontend', 'dist');
const publicDest   = path.join(DIST, 'public');

if (!skipFe && fs.existsSync(frontendDist)) {
  copy(frontendDist, publicDest);
} else if (!skipFe) {
  console.warn('  ⚠ Frontend dist not found – skipping static assets');
}

// ── Step 5: Generate pkg config ──────────────────────────────────────────────

console.log('\n── Step 5: Assemble portable distribution ───────────────────────');

const PORTABLE_DIR = path.join(RELEASE, 'devbridge-win-x64');
fs.mkdirSync(PORTABLE_DIR, { recursive: true });

// Copy server bundle
fs.copyFileSync(serverDest, path.join(PORTABLE_DIR, 'server.cjs'));
console.log('  copied  server.cjs');

// Copy frontend assets
if (fs.existsSync(publicDest)) {
  copy(publicDest, path.join(PORTABLE_DIR, 'public'));
} else {
  console.warn('  ⚠ public/ not found — run without --skip-fe for full build');
}

// Copy the currently running node.exe as the embedded runtime
const nodeExe = process.execPath;
fs.copyFileSync(nodeExe, path.join(PORTABLE_DIR, 'node.exe'));
console.log(`  copied  node.exe  (${(fs.statSync(nodeExe).size / 1024 / 1024).toFixed(1)} MB)`);

// Write start.bat launcher
const startBat = `@echo off
setlocal
set "APP_DIR=%~dp0"

:: Kill any process already using port 4000
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":4000 "') do (
  taskkill /F /PID %%a >nul 2>&1
)

"%APP_DIR%node.exe" "%APP_DIR%server.cjs" %*
`;
fs.writeFileSync(path.join(PORTABLE_DIR, 'start.bat'), startBat);
console.log('  wrote   start.bat');

// Write start.ps1 launcher (PowerShell)
const startPs1 = `$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Kill any process already using port 4000
$existing = Get-NetTCPConnection -LocalPort 4000 -ErrorAction SilentlyContinue
if ($existing) {
  $existing | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
}

& "$AppDir\\node.exe" "$AppDir\\server.cjs" @Args
`;
fs.writeFileSync(path.join(PORTABLE_DIR, 'start.ps1'), startPs1);
console.log('  wrote   start.ps1');

// Write default config
const defaultConfig = {
  mode:      'local',
  port:      4000,
  cors:      { enabled: false, origins: [] },
  rateLimit: { max: 100, timeWindow: '1 minute' },
};
fs.writeFileSync(
  path.join(PORTABLE_DIR, 'devbridge.json'),
  JSON.stringify(defaultConfig, null, 2),
);
console.log('  wrote   devbridge.json');

// Write README
fs.writeFileSync(path.join(PORTABLE_DIR, 'README.txt'), `DevBridge v${VERSION} — Portable Edition
==========================================

Quick start (Windows):
  1. Double-click start.bat
     OR run: .\\node.exe server.cjs
  2. Open http://localhost:4000 in your browser

Configuration:
  Edit devbridge.json to change port, mode (local/lan), CORS, etc.

Environment variables:
  PORT=4000                         overrides config port
  DEVBRIDGE_MODE=local|lan
  DEVBRIDGE_API_KEY=secret          enables API key auth
  DEVBRIDGE_STATIC_DIR=C:\\path     custom frontend assets path

Requirements:
  Windows 10/11 x64 — no additional runtime required
`);
console.log('  wrote   README.txt');

// ── Step 6: Copy native node_modules → portable dir ─────────────────────────
//
// Native modules (node-hid, usb, serialport) have .node binaries that can't
// be bundled. We copy their entire package directories — plus their own
// transitive deps (pnpm keeps those as siblings in the same virtual-store
// node_modules folder) — into release/devbridge-win-x64/node_modules/.

console.log('\n── Step 6: Copy native node_modules → portable dir ──────────────');

import { createRequire } from 'node:module';
const serverRequire = createRequire(path.join(ROOT, 'packages', 'server', 'package.json'));

const nativePackages = [
  'node-hid',
  'usb',
  'serialport',
];

const nativeModulesDestDir = path.join(PORTABLE_DIR, 'node_modules');
fs.mkdirSync(nativeModulesDestDir, { recursive: true });

const alreadyCopied = new Set();

function copyPackageAndSiblings(pkgName) {
  if (alreadyCopied.has(pkgName)) return;
  try {
    const pkgJsonPath = serverRequire.resolve(`${pkgName}/package.json`);
    const pkgDir      = path.dirname(pkgJsonPath);   // .../node_modules/node-hid
    const siblingDir  = path.dirname(pkgDir);         // .../node_modules  (pnpm virtual store siblings)

    // Copy all packages in the sibling directory (pkg itself + its peer deps)
    for (const entry of fs.readdirSync(siblingDir)) {
      const entryPath = path.join(siblingDir, entry);
      if (!fs.statSync(entryPath).isDirectory()) continue;

      if (entry.startsWith('@')) {
        // Scoped packages: copy each scoped package inside
        for (const scoped of fs.readdirSync(entryPath)) {
          const scopedPkg  = `${entry}/${scoped}`;
          const scopedSrc  = path.join(entryPath, scoped);
          const scopedDest = path.join(nativeModulesDestDir, entry, scoped);
          if (!alreadyCopied.has(scopedPkg) && fs.statSync(scopedSrc).isDirectory()) {
            alreadyCopied.add(scopedPkg);
            fs.cpSync(scopedSrc, scopedDest, { recursive: true });
            console.log(`  copied  ${scopedPkg}`);
          }
        }
      } else {
        const dest = path.join(nativeModulesDestDir, entry);
        if (!alreadyCopied.has(entry)) {
          alreadyCopied.add(entry);
          fs.cpSync(entryPath, dest, { recursive: true });
          console.log(`  copied  ${entry}`);
        }
      }
    }
    // Mark the top-level package name as copied (may differ from dir name for scoped)
    alreadyCopied.add(pkgName);
  } catch {
    console.log(`  skip    ${pkgName} (not installed or optional)`);
    alreadyCopied.add(pkgName); // avoid retry
  }
}

for (const pkgName of nativePackages) {
  console.log(`\n  resolving ${pkgName}…`);
  copyPackageAndSiblings(pkgName);
}
console.log(`\n  total   ${alreadyCopied.size} package(s) copied`);

// ── Step 7: Create zip archive ───────────────────────────────────────────────

console.log('\n── Step 7: Create zip archive ───────────────────────────────────');

const zipName    = `DevBridge-v${VERSION}-win-x64.zip`;
const zipOutPath = path.join(RELEASE, zipName);

// Use PowerShell's Compress-Archive on Windows, zip on Linux/macOS
const isWin = process.platform === 'win32';
if (isWin) {
  run(
    `powershell -Command "Compress-Archive -Path '${PORTABLE_DIR.replace(/\\/g, '\\\\')}\\*' -DestinationPath '${zipOutPath.replace(/\\/g, '\\\\')}' -Force"`,
    ROOT,
  );
} else {
  run(`zip -r "${zipOutPath}" .`, PORTABLE_DIR);
}

if (fs.existsSync(zipOutPath)) {
  const zipSizeMb = (fs.statSync(zipOutPath).size / 1024 / 1024).toFixed(1);
  console.log(`  ✓  ${zipName}  (${zipSizeMb} MB)`);
}

// ── Done ──────────────────────────────────────────────────────────────────────

const zipPath = path.join(RELEASE, `DevBridge-v${VERSION}-win-x64.zip`);
const zipSize = fs.existsSync(zipPath)
  ? (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)
  : '?';

console.log(`
────────────────────────────────────────────────────────────
  ✓  Build complete

  ZIP   release/DevBridge-v${VERSION}-win-x64.zip  (${zipSize} MB)
  Run   release\\devbridge-win-x64\\start.bat
────────────────────────────────────────────────────────────
`);
