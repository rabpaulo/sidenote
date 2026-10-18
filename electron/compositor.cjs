const { spawn } = require('child_process');

// Asks the X server whether a compositing manager owns _NET_WM_CM_S<screen>, through
// libX11 with ctypes, so no extra tool is needed. Prints 1 or 0 right away and, when
// there is none yet, keeps checking and prints 1 once one starts.
const WATCH = `
import ctypes, ctypes.util, sys, time
x = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11") or "libX11.so.6")
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XDefaultScreen.argtypes = [ctypes.c_void_p]
x.XInternAtom.restype = ctypes.c_ulong
x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x.XGetSelectionOwner.restype = ctypes.c_ulong
x.XGetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
display = x.XOpenDisplay(None)
if not display:
    sys.exit(2)
atom = x.XInternAtom(display, b"_NET_WM_CM_S%d" % x.XDefaultScreen(display), 0)
present = x.XGetSelectionOwner(display, atom) != 0
print(int(present), flush=True)
if not present:
    while x.XGetSelectionOwner(display, atom) == 0:
        time.sleep(1)
    print(1, flush=True)
`;

/**
 * On X11 a transparent window only gets an alpha channel when a compositor is already
 * running as it is created; one started later leaves it opaque black. Resolves to
 * whether one runs now (null when unknown, e.g. Wayland, where there always is one)
 * and calls `onStart` if one starts afterwards.
 */
function watchCompositor({ onStart, env = process.env } = {}) {
  if (process.platform !== 'linux' || !env.DISPLAY || env.WAYLAND_DISPLAY) {
    return { present: Promise.resolve(null), stop() {} };
  }
  let child;
  try {
    child = spawn(env.PYTHON_BIN || 'python3', ['-c', WATCH], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return { present: Promise.resolve(null), stop() {} };
  }
  let lines = 0;
  const present = new Promise((resolve) => {
    // Without an answer soon, assume the window can be transparent rather than delay it.
    const timer = setTimeout(() => resolve(null), 3000);
    child.on('error', () => resolve(null));
    child.on('exit', () => resolve(null));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        lines += 1;
        if (lines === 1) {
          clearTimeout(timer);
          resolve(line.trim() === '1');
        } else if (line.trim() === '1') {
          onStart?.();
        }
      }
    });
  });
  return {
    present,
    stop() {
      if (child.exitCode === null) child.kill();
    },
  };
}

module.exports = { watchCompositor };
