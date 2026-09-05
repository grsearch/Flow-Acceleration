'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

function acceptsGzip(request) {
  return String(request.headers['accept-encoding'] || '').split(',').some((part) => {
    const [coding, ...params] = part.trim().split(';');
    return coding === 'gzip' && !params.some((p) => /^\s*q=0(?:\.0*)?\s*$/.test(p));
  });
}

function installDashboardAssets(app, publicDir) {
  const assets = new Map();
  for (const name of fs.readdirSync(publicDir)) {
    if (!/^[\w.-]+\.(html|js|css)$/.test(name)) continue;
    const body = fs.readFileSync(path.join(publicDir, name));
    assets.set(`/${name}`, { body, gzip: zlib.gzipSync(body),
      etag: `W/"${crypto.createHash('sha256').update(body).digest('hex')}"`,
      type: name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'application/javascript' : 'text/css' });
  }
  app.use((request, response, next) => {
    const asset = assets.get(request.path === '/' ? '/index.html' : request.path);
    if (!asset || !['GET', 'HEAD'].includes(request.method)) return next();
    response.set('Cache-Control', 'no-cache');
    response.set('Vary', 'Accept-Encoding');
    response.set('ETag', asset.etag);
    if (request.headers['if-none-match'] === asset.etag) return response.status(304).end();
    const gzip = acceptsGzip(request);
    const body = gzip ? asset.gzip : asset.body;
    response.set('Content-Type', `${asset.type}; charset=utf-8`);
    if (gzip) response.set('Content-Encoding', 'gzip');
    response.set('Content-Length', String(body.length));
    response.status(200).end(request.method === 'HEAD' ? undefined : body);
  });
  app.use('/api', (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    const send = response.send.bind(response);
    response.json = (value) => {
      const body = JSON.stringify(value);
      response.set('Content-Type', 'application/json; charset=utf-8');
      response.vary('Accept-Encoding');
      if (body.length < 1024 || !acceptsGzip(request)) return send(body);
      zlib.gzip(body, (error, compressed) => {
        if (response.destroyed) return;
        if (error) return send(body);
        response.set('Content-Encoding', 'gzip');
        send(compressed);
      });
      return response;
    };
    next();
  });
}

module.exports = { installDashboardAssets, acceptsGzip };
