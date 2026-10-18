import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { startDev } from './dev.js';

test('dev passes the actual Vite URL to Electron when the requested port is occupied', async (t) => {
  const occupied = http.createServer((_req, res) => res.end('another renderer'));
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const port = occupied.address().port;
  const desktop = new EventEmitter();
  desktop.pid = process.pid;
  desktop.exitCode = null;
  desktop.signalCode = null;
  desktop.kill = (signal) => {
    desktop.signalCode = signal;
    desktop.emit('exit', null, signal);
  };
  let desktopUrl;
  const dev = await startDev({
    viteOptions: { server: { host: '127.0.0.1', port } },
    launchDesktop: (url) => { desktopUrl = url; return desktop; },
  });
  t.after(() => dev.close());

  assert.notEqual(Number(new URL(desktopUrl).port), port);
  const response = await fetch(desktopUrl);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /@vite\/client/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'another renderer');

  await dev.close();
  assert.equal(desktop.signalCode, 'SIGTERM');
  assert.equal(dev.renderer.httpServer.listening, false);
});
