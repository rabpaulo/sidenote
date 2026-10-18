import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electron from 'electron';
import { createServer } from 'vite';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

// Electron owns the backend lifecycle, including reusing a running backend.
export async function startDev({
  viteOptions = {},
  launchDesktop = (url) => spawn(electron, ['.', '--managed-renderer'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, INTERVIEWAI_DEV_URL: url },
  }),
} = {}) {
  const renderer = await createServer({ root: projectRoot, ...viteOptions });
  let desktop;
  let closing;
  const close = () => {
    closing ||= (async () => {
      if (desktop?.pid && desktop.exitCode === null && desktop.signalCode === null) {
        const exited = new Promise((resolve) => desktop.once('exit', resolve));
        desktop.kill('SIGTERM');
        await exited;
      }
      await renderer.close();
    })();
    return closing;
  };

  try {
    await renderer.listen();
    renderer.printUrls();
    const url = renderer.resolvedUrls.local[0];
    desktop = launchDesktop(url);
    return { renderer, desktop, url, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const dev = await startDev();
    const finish = async (code) => {
      await dev.close();
      process.exitCode = code;
    };
    dev.desktop.once('error', (error) => {
      console.error('[Dev] Failed to launch Electron:', error.message);
      void finish(1);
    });
    dev.desktop.once('exit', (code, signal) => {
      void finish(signal ? 0 : (code ?? 1));
    });
    process.once('SIGINT', () => void finish(0));
    process.once('SIGTERM', () => void finish(0));
  } catch (error) {
    console.error('[Dev] Failed to start:', error.message);
    process.exitCode = 1;
  }
}
