import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findOnPath } from './cli-process.js';

// What this computer offers to local models: RAM, CPU and the GPUs with their video
// memory. Every probe is optional and quick; a missing tool just leaves a GPU out.

const GIB = 1024 ** 3;
const PROBE_TIMEOUT_MS = 5000;
const round = (value) => Math.round(value * 10) / 10;
const VENDORS = { '0x10de': 'nvidia', '0x1002': 'amd', '0x8086': 'intel' };
const VENDOR_NAMES = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' };

function run(command, args) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        resolve(error ? null : String(stdout));
      });
    } catch {
      resolve(null);
    }
  });
}

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` (MiB). */
export function parseNvidiaSmi(text) {
  return String(text || '').split('\n').map((line) => line.split(',').map((part) => part.trim()))
    .filter(([name, memory]) => name && Number(memory) > 0)
    .map(([name, memory]) => ({ name, vendor: 'nvidia', vramGb: round(Number(memory) / 1024), dedicated: true }));
}

/** Third field of `lspci -mm` is the device name, e.g. "Navi 23 [Radeon RX 6600/6600 XT/6600M]". */
export function parseLspciName(text) {
  const fields = String(text || '').match(/"([^"]*)"/g)?.map((field) => field.slice(1, -1)) || [];
  const device = fields[2] || '';
  return device.match(/\[([^\]]+)\]/)?.[1] || device || null;
}

async function linuxGpus(skipNvidia) {
  const root = '/sys/class/drm';
  let cards = [];
  try { cards = fs.readdirSync(root).filter((name) => /^card\d+$/.test(name)); } catch { return []; }
  const gpus = [];
  for (const card of cards) {
    const device = path.join(root, card, 'device');
    const read = (file) => { try { return fs.readFileSync(path.join(device, file), 'utf8').trim(); } catch { return ''; } };
    const vendor = VENDORS[read('vendor')];
    if (!vendor || (vendor === 'nvidia' && skipNvidia)) continue;
    // Only AMD exposes the VRAM size here; an Intel iGPU shares the RAM.
    const vram = Number(read('mem_info_vram_total')) || 0;
    // A few hundred MB of "VRAM" is an APU's carve-out, not a graphics card.
    const dedicated = vendor !== 'intel' && vram >= 2 * GIB;
    let name = null;
    let address = '';
    try { address = path.basename(fs.realpathSync(device)); } catch {}
    if (address && findOnPath('lspci')) name = parseLspciName(await run('lspci', ['-mm', '-s', address]));
    gpus.push({ name: name || `GPU ${VENDOR_NAMES[vendor]}`, vendor, vramGb: dedicated ? round(vram / GIB) : 0, dedicated });
  }
  return gpus;
}

// The registry keeps the real VRAM size; Win32_VideoController caps it at 4 GB.
const WINDOWS_GPU_SCRIPT = "Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | "
  + "ForEach-Object { [pscustomobject]@{ name = $_.DriverDesc; memory = $_.'HardwareInformation.qwMemorySize' } } | ConvertTo-Json -Compress";

export function parseWindowsGpus(text) {
  let list;
  try { list = JSON.parse(String(text || '').trim() || '[]'); } catch { return []; }
  return (Array.isArray(list) ? list : [list])
    .filter((entry) => entry?.name && !/basic|remote|virtual|parsec|mirage/i.test(entry.name))
    .map((entry) => {
      const vendor = /nvidia/i.test(entry.name) ? 'nvidia' : /amd|radeon/i.test(entry.name) ? 'amd' : /intel/i.test(entry.name) ? 'intel' : 'other';
      const vram = Number(entry.memory) || 0;
      const dedicated = vendor !== 'intel' && vram >= 2 * GIB;
      return { name: entry.name, vendor, vramGb: dedicated ? round(vram / GIB) : 0, dedicated };
    });
}

async function windowsGpus(skipNvidia) {
  const gpus = parseWindowsGpus(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_GPU_SCRIPT]));
  return gpus.filter((gpu) => !(skipNvidia && gpu.vendor === 'nvidia'));
}

/**
 * { platform, arch, cpu, cores, ramGb, gpus: [{ name, vendor, vramGb, dedicated, unified? }] }.
 * NVIDIA comes from nvidia-smi on every system; AMD and Intel from sysfs (Linux) or the
 * registry (Windows); Apple Silicon reports its unified memory.
 */
export async function scanHardware({ platform = process.platform, arch = process.arch } = {}) {
  const cpus = os.cpus();
  const ramGb = round(os.totalmem() / GIB);
  const hardware = { platform, arch, cpu: cpus[0]?.model?.trim() || null, cores: cpus.length, ramGb, gpus: [] };
  if (platform === 'darwin') {
    if (arch === 'arm64') hardware.gpus.push({ name: 'Apple Silicon (memória unificada)', vendor: 'apple', vramGb: ramGb, dedicated: false, unified: true });
    return hardware;
  }
  const nvidia = parseNvidiaSmi(await run(findOnPath('nvidia-smi') || 'nvidia-smi',
    ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']));
  hardware.gpus.push(...nvidia);
  if (platform === 'linux') hardware.gpus.push(...await linuxGpus(nvidia.length > 0));
  if (platform === 'win32') hardware.gpus.push(...await windowsGpus(nvidia.length > 0));
  return hardware;
}
