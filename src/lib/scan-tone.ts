let context: AudioContext | undefined;

/** iOS only lets audio start inside a user gesture, so call this from the tap that opens the camera. */
export function primeScanTone() {
  try {
    context ??= new AudioContext();
    void context.resume();
  } catch { /* no Web Audio: scanning still works silently */ }
}

/** A short high beep for a match, a lower buzz for a problem. Silent until primed. */
export function playScanTone(ok: boolean) {
  if (!context || context.state !== 'running') return;
  const start = context.currentTime;
  const length = ok ? 0.12 : 0.3;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = ok ? 'sine' : 'square';
  oscillator.frequency.value = ok ? 1320 : 300;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(ok ? 0.18 : 0.08, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + length + 0.02);
}
