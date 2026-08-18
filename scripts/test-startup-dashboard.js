'use strict';

const assert = require('assert');
const http = require('http');
const {
  STARTUP_HTML,
  createStartupDashboardServer,
} = require('../src/server/startup-dashboard');

function request(port, pathname) {
  return new Promise((resolve, reject) => {
    const call = http.get({ host: '127.0.0.1', port, path: pathname }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    call.once('error', reject);
  });
}

async function main() {
  assert.ok(STARTUP_HTML.includes('系统正在启动'));
  assert.ok(STARTUP_HTML.includes('http-equiv="refresh"'));
  const server = createStartupDashboardServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address();
    const page = await request(port, '/');
    assert.strictEqual(page.statusCode, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.ok(page.body.includes('数据库和策略状态正在恢复'));
    const health = await request(port, '/health');
    assert.strictEqual(health.statusCode, 503);
    assert.deepStrictEqual(JSON.parse(health.body), { status: 'starting', ready: false });
    const api = await request(port, '/api/overview');
    assert.strictEqual(api.statusCode, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('test-startup-dashboard: ok');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
