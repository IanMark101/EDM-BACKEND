import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./initialize-clinic.ts', import.meta.url))], { stdio: 'inherit', windowsHide: true });
child.on('exit', code => process.exit(code ?? 1));
