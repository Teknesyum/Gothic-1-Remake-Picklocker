import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log("Starting Vite...");
const vite = spawn('npx', ['vite'], { 
    stdio: 'inherit',
    shell: true 
});

setTimeout(() => {
    console.log("Starting Electron...");
    const electron = spawn('npx', ['cross-env', 'NODE_ENV=development', 'electron', '.'], { 
        stdio: 'inherit',
        shell: true 
    });

    electron.on('close', (code) => {
        console.log(`Electron process exited with code ${code}`);
        // Force kill the Vite process tree on Windows
        const killer = spawn('taskkill', ['/pid', vite.pid, '/f', '/t'], { shell: true });
        killer.on('close', () => {
            process.exit(code);
        });
    });
}, 2000);
