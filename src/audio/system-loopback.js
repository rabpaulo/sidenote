import workletUrl from './pcm-capture.worklet.js?url';

/**
 * Captures what the PC is playing (Electron desktop loopback, available on Windows)
 * and hands 50 ms PCM16 16 kHz mono packets to onPcm. Linux uses parec on the backend instead.
 */
export async function startSystemLoopback(onPcm) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Captura do áudio do sistema indisponível');
  // Chromium only grants desktop audio together with a desktop video track; keep that track tiny.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'desktop' } },
    video: { mandatory: { chromeMediaSource: 'desktop', maxWidth: 320, maxHeight: 180, maxFrameRate: 1 } },
  });
  const stopTracks = () => stream.getTracks().forEach((track) => track.stop());
  if (!stream.getAudioTracks().length) {
    stopTracks();
    throw new Error('O sistema não forneceu o áudio do PC');
  }
  const context = new AudioContext();
  try {
    await context.audioWorklet.addModule(workletUrl);
    await context.resume();
  } catch (error) {
    stopTracks();
    context.close();
    throw error;
  }
  const source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  const node = new AudioWorkletNode(context, 'pcm-capture');
  const muted = context.createGain();
  muted.gain.value = 0;
  node.port.onmessage = ({ data }) => {
    if (data.type === 'pcm') onPcm(data.buffer);
  };
  source.connect(node);
  node.connect(muted);
  muted.connect(context.destination);

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      source.disconnect();
      node.disconnect();
      muted.disconnect();
      node.port.close();
      stopTracks();
      context.close().catch(() => {});
    },
  };
}
