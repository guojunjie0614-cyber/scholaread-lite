import { execFileSync, spawn } from 'node:child_process';
import electron from 'electron';
import { createMacApp, createIconSet } from './create-mac-app.mjs';

if (process.platform === 'darwin') {
  createIconSet();
  execFileSync('/usr/bin/open', [createMacApp()], { stdio: 'inherit' });
} else {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, ['.'], { stdio: 'inherit', env });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
