// Downsample to 16 kHz mono PCM16 and transfer 50 ms packets off the audio thread.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.sum = 0;
    this.weight = 0;
    this.ratio = sampleRate / 16000;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') {
        this.stopped = true;
        if (this.weight > 0) this.samples.push(this.sum / this.weight);
        this.send();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  send() {
    if (!this.samples.length) return;
    const pcm = new Uint8Array(this.samples.length * 2);
    const view = new DataView(pcm.buffer);
    this.samples.forEach((sample, index) => {
      const clipped = Math.max(-1, Math.min(1, sample));
      view.setInt16(index * 2, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
    });
    this.samples = [];
    this.port.postMessage({ type: 'pcm', buffer: pcm.buffer }, [pcm.buffer]);
  }

  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      const mono = channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length;
      let remaining = 1;
      while (remaining > 1e-8) {
        const weight = Math.min(remaining, this.ratio - this.weight);
        this.sum += mono * weight;
        this.weight += weight;
        remaining -= weight;
        if (this.weight >= this.ratio - 1e-8) {
          this.samples.push(this.sum / this.weight);
          this.sum = 0;
          this.weight = 0;
          if (this.samples.length >= 800) this.send();
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
