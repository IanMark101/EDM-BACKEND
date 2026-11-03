import { spawnSync } from 'node:child_process';
// Windows does not deliver SIGTERM to Node descendants. Stop only the tree we
// started, so Ctrl+C releases both ports and the backup owner as well.
export function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGTERM');
}
