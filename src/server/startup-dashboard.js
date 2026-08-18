'use strict';

const http = require('http');
const { fork } = require('child_process');

const STARTUP_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="5">
  <title>Flow Acceleration · 启动中</title>
  <style>
    :root{color-scheme:dark}body{margin:0;background:#06151b;color:#eaf7f8;font-family:system-ui,sans-serif}
    main{max-width:720px;margin:14vh auto;padding:36px;border:1px solid #1d4652;border-radius:22px;background:#0a222b}
    b{color:#adff38;font-size:30px}.dot{display:inline-block;width:11px;height:11px;margin-right:10px;border-radius:50%;background:#adff38;box-shadow:0 0 16px #adff38}
    p{color:#9cc9d3;line-height:1.7}small{color:#6e9faa}
  </style>
</head>
<body><main><div><span class="dot"></span><b>系统正在启动</b></div>
<p>数据库和策略状态正在恢复。数据采集服务完成初始化后，本页会自动刷新进入 Dashboard。</p>
<small>大型历史库冷启动期间不再显示连接超时；请稍候约 30～90 秒。</small></main></body>
</html>`;

function createStartupDashboardServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://startup.local');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Retry-After', '5');
    response.setHeader('Connection', 'close');
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === '/health' || url.pathname.startsWith('/api/')) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'starting', ready: false }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(STARTUP_HTML);
  });
}

function launchStartupDashboard({ host, port, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, [], {
      env: {
        ...process.env,
        FLOW_STARTUP_DASHBOARD_CHILD: '1',
        FLOW_STARTUP_DASHBOARD_HOST: String(host),
        FLOW_STARTUP_DASHBOARD_PORT: String(port),
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Startup Dashboard did not listen within ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (callback) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      callback();
      return true;
    };
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code) => {
      if (!settled) finish(() => reject(new Error(`Startup Dashboard exited with code ${code}`)));
    });
    child.on('message', (message) => {
      if (message?.type === 'error') {
        finish(() => reject(new Error(message.error || 'Startup Dashboard failed')));
      }
      if (message?.type !== 'ready') return;
      finish(() => resolve({
        pid: child.pid,
        host: message.host,
        port: message.port,
        stop: () => new Promise((stopResolve) => {
          if (!child.connected || child.exitCode !== null) {
            stopResolve();
            return;
          }
          const stopTimer = setTimeout(() => {
            child.kill();
            stopResolve();
          }, 5_000);
          const stopped = () => {
            clearTimeout(stopTimer);
            stopResolve();
          };
          child.once('exit', stopped);
          child.on('message', (next) => {
            if (next?.type === 'stopped') stopped();
          });
          child.send({ type: 'shutdown' });
        }),
      }));
    });
  });
}

function runChild() {
  const host = process.env.FLOW_STARTUP_DASHBOARD_HOST || '0.0.0.0';
  const port = Number(process.env.FLOW_STARTUP_DASHBOARD_PORT || 3001);
  const server = createStartupDashboardServer();
  const stop = () => server.close(() => {
    if (process.send) process.send({ type: 'stopped' });
    process.exit(0);
  });
  process.on('message', (message) => {
    if (message?.type === 'shutdown') stop();
  });
  process.on('disconnect', stop);
  server.once('error', (error) => {
    if (process.send) process.send({ type: 'error', error: error.message });
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    const address = server.address();
    if (process.send) process.send({ type: 'ready', host, port: address.port });
  });
}

if (require.main === module && process.env.FLOW_STARTUP_DASHBOARD_CHILD === '1') runChild();

module.exports = {
  STARTUP_HTML,
  createStartupDashboardServer,
  launchStartupDashboard,
};
