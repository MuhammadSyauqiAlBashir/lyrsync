// Microphone capture: keeps the last few seconds as 16 kHz mono PCM and turns
// any recent slice into a small WAV. Encoding on the phone means the server
// never has to decode arbitrary audio formats.

const RATE = 16000
const KEEP_SECONDS = 12

export class Mic {
  constructor() {
    this.ring = new Int16Array(RATE * KEEP_SECONDS)
    this.written = 0 // total samples ever written
    this.lastSampleAt = 0 // performance.now() when the newest sample arrived
    this.stream = null
    this.ctx = null
    this.onEnded = null
  }

  get active() {
    return !!this.stream && this.stream.getAudioTracks().some((t) => t.readyState === "live")
  }

  // Must be called from a tap/click handler the first time (iOS rule).
  async start() {
    if (this.active && this.ctx && this.ctx.state === "running") return
    await this.stop()
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new MicError("unsupported", "This browser can't use the microphone.")
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      })
    } catch (e) {
      const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError")
      throw new MicError(denied ? "denied" : "failed",
        denied ? "Microphone access is off. Allow it in Settings → Safari → Microphone (or tap Allow)."
               : "Couldn't start the microphone.")
    }
    const Ctx = window.AudioContext || window.webkitAudioContext
    this.ctx = new Ctx()
    await this.ctx.audioWorklet.addModule("/recorder-worklet.js")
    const src = this.ctx.createMediaStreamSource(this.stream)
    const tap = new AudioWorkletNode(this.ctx, "tap")
    const mute = this.ctx.createGain()
    mute.gain.value = 0
    src.connect(tap).connect(mute).connect(this.ctx.destination) // keeps the graph pulling
    this.ratio = this.ctx.sampleRate / RATE
    this.acc = 0
    this.accN = 0
    this.phase = 0
    this.written = 0
    tap.port.onmessage = (e) => this.push(e.data)
    if (this.ctx.state !== "running") {
      // iOS only lets audio resume after a tap; don't hang waiting for it.
      await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 1500))])
      if (this.ctx.state !== "running") {
        await this.stop()
        throw new MicError("gesture", "Tap the button again to start listening.")
      }
    }
    for (const t of this.stream.getAudioTracks()) {
      t.addEventListener("ended", () => this.onEnded && this.onEnded())
    }
  }

  async stop() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop()
    this.stream = null
    if (this.ctx) {
      try { await this.ctx.close() } catch (_) {}
    }
    this.ctx = null
  }

  // Box-filter downsampling: average the input samples that fall in each
  // output sample's window. Cheap, and good enough for fingerprinting.
  push(input) {
    const ring = this.ring
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i]
      this.accN++
      this.phase += 1
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio
        const v = Math.max(-1, Math.min(1, this.acc / this.accN))
        ring[this.written % ring.length] = v < 0 ? v * 0x8000 : v * 0x7fff
        this.written++
        this.acc = 0
        this.accN = 0
      }
    }
    this.lastSampleAt = performance.now()
  }

  // Total seconds recorded since start() (keeps growing).
  get recorded() {
    return this.written / RATE
  }

  // Seconds of audio available to take() (at most KEEP_SECONDS).
  get buffered() {
    return Math.min(this.written, this.ring.length) / RATE
  }

  // The most recent `seconds` of audio as a WAV blob, plus the
  // performance.now() time at which that audio began.
  take(seconds) {
    const n = Math.min(Math.floor(seconds * RATE), this.written, this.ring.length)
    const pcm = new Int16Array(n)
    const start = this.written - n
    for (let i = 0; i < n; i++) pcm[i] = this.ring[(start + i) % this.ring.length]
    return { wav: toWav(pcm), startedAt: this.lastSampleAt - (n / RATE) * 1000, seconds: n / RATE }
  }
}

export class MicError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function toWav(pcm) {
  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(buf)
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE")
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, "data"); v.setUint32(40, pcm.length * 2, true)
  new Int16Array(buf, 44).set(pcm)
  return new Blob([buf], { type: "audio/wav" })
}
