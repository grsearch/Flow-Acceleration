'use strict';

const ResearchServer = require('./server');

let snapshot = { at: 0, sections: {}, database: {} };
let server;
let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  await server?.stop();
  process.exit(0);
}

process.on('message', async (message) => {
  if (message?.type === 'RUNTIME') { snapshot = message.snapshot; return; }
  if (message?.type === 'STOP') { await stop(); return; }
  if (message?.type !== 'INIT' || server) return;
  try {
    snapshot = message.snapshot;
    const config = message.config;
    config.dashboardCache = { ...config.dashboardCache, enabled: true };
    const store = {
      config: config.storage,
      healthSnapshot: () => snapshot.database,
    };
    const options = { config, runtimeIdentity: message.runtimeIdentity, store,
      runtimeSnapshotState: () => ({
        mode: 'INDEPENDENT_HTTP_PROCESS', dashboardPid: process.pid,
        sampledAt: snapshot.at, ageMs: snapshot.at ? Date.now() - snapshot.at : null,
        status: snapshot.at && Date.now() - snapshot.at <= 15_000 ? 'READY' : 'STALE',
        errors: snapshot.errors || [],
      }) };
    for (const key of Object.keys(snapshot.sections || {})) {
      options[key] = {
        health: () => snapshot.sections[key] || {},
        stats: () => snapshot.sections[key] || {},
        maintenanceHealth: () => snapshot.maintenance,
      };
    }
    options.engine ||= { stats: () => ({}) };
    options.stream ||= { health: () => ({ regions: [] }) };
    options.labeler ||= { stats: () => ({}) };
    server = new ResearchServer(options);
    await server.start();
    process.send?.({ type: 'READY', port: server.httpServer.address().port });
  } catch (error) {
    process.send?.({ type: 'ERROR', error: error.message });
    await stop();
  }
});
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
