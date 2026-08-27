const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = __dirname;
const port = Number(process.env.PORT || 8080);
const configKeys = [
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_CLOUD',
  'AZURE_AUTHORITY_HOST',
  'API_URL',
  'API_SCOPE',
  'MOCK_MODE',
];
const runtimeConfig = Object.fromEntries(
  configKeys.map((key) => [key, process.env[key] || '']),
);
const runtimeConfigScript = `window.__APP_CONFIG__ = ${JSON.stringify(runtimeConfig)};\n`;

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

http.createServer((request, response) => {
  const requestPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (requestPath === '/runtime-config.js') {
    response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(runtimeConfigScript);
    return;
  }

  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  let filePath = path.resolve(root, relativePath);

  if (!filePath.startsWith(`${root}${path.sep}`) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(root, 'index.html');
  }

  response.setHeader('Content-Type', contentTypes[path.extname(filePath)] || 'application/octet-stream');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(filePath)
    .on('error', () => {
      response.statusCode = 500;
      response.end('Unable to serve application.');
    })
    .pipe(response);
}).listen(port, '0.0.0.0');