'use strict';
const http = require('http');
const { spawn } = require('child_process');

const port = process.env.PORT || process.env.CAREER_FIRM_PORT || 8765;
const healthPath = process.env.HEALTH_PATH || '/health';
const intervalMs = Number(process.env.MONITOR_INTERVAL_MS || 15000);
let child = null;

function startApp() {
  child = spawn('npm', ['start'], { stdio: 'inherit', shell: true });
  child.on('exit', (code) => { child = null; console.error('app exited with code', code); });
}

function checkHealth() {
  const req = http.get({ hostname: '127.0.0.1', port, path: healthPath, timeout: 5000 }, (res) => {
    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) return;
    console.error('health check failed:', res.statusCode);
    restart();
  });
  req.on('error', () => { console.error('app unreachable'); restart(); });
  req.on('timeout', () => { req.destroy(); console.error('health check timeout'); restart(); });
}

function restart() {
  try { if (child) { child.kill(); child = null; } } catch (e) {}
  console.log('restarting app...');
  startApp();
}

startApp();
setInterval(checkHealth, intervalMs);
console.log('monitor started on port', port, 'interval', intervalMs);
