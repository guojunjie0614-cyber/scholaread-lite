import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (file, args) => execFileSync(file, args, { stdio: 'inherit' });

function refreshDesktopShortcut(destination) {
  const shortcut = path.join(os.homedir(), 'Desktop/ScholarLite.app');
  // Only refresh our existing link; leave custom launchers and real apps alone.
  if (!fs.lstatSync(shortcut, { throwIfNoEntry: false })?.isSymbolicLink()) return;
  const target = path.resolve(path.dirname(shortcut), fs.readlinkSync(shortcut));
  if (target !== destination) return;
  const replacement = path.join(path.dirname(shortcut), `.ScholarLite-${process.pid}.app`);
  fs.symlinkSync(destination, replacement, 'dir');
  try {
    // A new filesystem identity makes Finder discard the old link's icon cache.
    fs.renameSync(replacement, shortcut);
  } finally {
    if (fs.lstatSync(replacement, { throwIfNoEntry: false })) fs.unlinkSync(replacement);
  }
}

// A local application entry point, linked to this checkout so PDF.js, native OCR
// and the existing Python environment retain their original runtime locations.
export function createMacApp() {
  if (process.platform !== 'darwin') throw new Error('此启动入口需要 macOS。');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const release = path.join(root, 'release');
  fs.mkdirSync(release, { recursive: true });
  const staging = fs.mkdtempSync(path.join(release, '.mac-app-'));
  const bundle = path.join(staging, 'ScholarLite.app');
  const contents = path.join(bundle, 'Contents');
  try {
    run('/usr/bin/ditto', ['--noqtn', path.join(root, 'node_modules/electron/dist/Electron.app'), bundle]);
    const plist = path.join(contents, 'Info.plist');
    for (const [key, value] of Object.entries({
      CFBundleName: 'ScholarLite', CFBundleDisplayName: 'ScholarLite',
      CFBundleExecutable: 'ScholarLite', CFBundleIdentifier: 'app.local.scholarlite',
      CFBundleShortVersionString: pkg.version, CFBundleVersion: pkg.version,
      CFBundleIconFile: 'ScholarLite.icns',
      LSApplicationCategoryType: 'public.app-category.productivity',
    })) run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
    run('/usr/libexec/PlistBuddy', ['-c', 'Delete :ElectronAsarIntegrity', plist]);
    fs.renameSync(path.join(contents, 'MacOS/Electron'), path.join(contents, 'MacOS/ScholarLite'));
    fs.copyFileSync(path.join(root, 'assets/ScholarLite.icns'), path.join(contents, 'Resources/ScholarLite.icns'));
    fs.symlinkSync(root, path.join(contents, 'Resources/app'), 'dir');
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
    const destination = path.join(release, 'ScholarLite.app');
    // Keep the previous bundle recoverable; never alter a running bundle in place.
    if (fs.existsSync(destination)) fs.renameSync(destination, path.join(release, `ScholarLite-previous-${Date.now()}.app`));
    fs.renameSync(bundle, destination);
    refreshDesktopShortcut(destination);
    console.log(`ScholarLite: ${destination}`);
    return destination;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function createIconSet() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'scholarlite-icon-'));
  const iconset = path.join(temp, 'ScholarLite.iconset');
  fs.mkdirSync(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = size * scale;
        run('/usr/bin/sips', ['-z', String(pixels), String(pixels), path.join(root, 'assets/app-icon.png'), '--out',
          path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
      }
    }
    run('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(root, 'assets/ScholarLite.icns')]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createIconSet();
  createMacApp();
}
