#!/usr/bin/env node
// Tiny static server for local preview of public/ (no dependencies).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PREVIEW_DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'design', 'preview-data');
const PORT = Number(process.env.PORT) || 8787;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  // /preview-data/* serves design/preview-data (the --ignore-ready fixture) so the widget can be
  // developed against real rows: open http://localhost:8787/?data=/preview-data/charities.json
  let base = ROOT;
  if (pathname.startsWith('/preview-data/')) {
    base = PREVIEW_DATA;
    pathname = pathname.slice('/preview-data'.length);
  }
  const file = path.join(base, path.normalize(pathname));
  if (!file.startsWith(base)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => console.log(`Preview: http://localhost:${PORT}/`));
