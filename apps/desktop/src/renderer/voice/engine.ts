import {
  Segmenter, applyCorrections, greetingReply, initialVoice, micPolicy, resample, stepVoice,
  type VoiceEffect, type VoiceEvent, type VoiceSettings, type VoiceState,
} from "@solo/shared";
import workletUrl from "./capture-worklet.js?url";
import { cancelSpeech, speak } from "./tts";

const LISTEN_TIMEOUT_MS = 8000; // after "Hey Solo" alone, how long we wait for the request
const TAIL_MS = 600; // after Solo stops talking, ignore the microphone briefly so the end of its own voice is not heard
const INTERRUPT_MIN_MS = 900; // the owner must speak this long over Solo before it counts as an interruption
const INTERRUPT_CHECK_EVERY_MS = 1500;

export interface HeardInfo { owner?: boolean; score?: number }

export interface EngineCallbacks {
  onState(s: VoiceState): void;
  /** A finished, accepted request (wake word stripped). Phase 4 routes this to the conversational AI. */
  onSubmit(text: string): void;
  /** Everything Whisper heard, even if ignored (for the on-screen log; never leaves the device). */
  onHeard(text: string, accepted: boolean, info: HeardInfo): void;
  onError(msg: string): void;
  /** Solo was addressed. The app uses this to bring its window forward if hidden. */
  onWake?(): void;
}

/**
 * Microphone -> segmenter -> local Whisper (+ speaker check) -> wake word / state machine.
 * Audio only leaves the audio thread when the segmenter finds speech, and only goes to local processing in the main
 * process, never to a network service. stop() releases the microphone.
 *
 * Solo never listens to itself: while it speaks (and for a moment after) the microphone is ignored, unless the owner's
 * voice is enrolled, in which case a sustained, verified owner voice can interrupt it. Without a voice print there is
 * no voice interruption (a speaker cannot tell a person from Solo's own voice coming out of the laptop), so Solo is
 * never cut off by its own echo.
 */
export class VoiceEngine {
  private state: VoiceState = initialVoice;
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private seg = new Segmenter();
  private busy = false;
  private listenTimer?: ReturnType<typeof setTimeout>;
  private replying = false;
  private muteUntil = 0;
  private enrolled = false;
  private capture?: { resolve: (pcm: Float32Array) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

  // interruption detection while Solo is speaking
  private interruptFrames: Float32Array[] = [];
  private interruptMs = 0;
  private lastInterruptCheck = 0;
  private checkingInterrupt = false;

  constructor(private cb: EngineCallbacks, private settings: () => VoiceSettings) {}

  get phase() { return this.state.phase; }
  setEnrolled(on: boolean) { this.enrolled = on; }

  private dispatch(e: VoiceEvent): VoiceEffect[] {
    const s = this.settings();
    const cfg = {
      wakeWords: s.wakeWords, quickWord: s.quickWord,
      voiceId: { enrolled: this.enrolled, onlyMyVoice: s.onlyMyVoice, greetings: s.greetingsWake },
    };
    const r = stepVoice(this.state, e, cfg);
    this.state = r.state;
    clearTimeout(this.listenTimer);
    if (this.state.phase === "listening") this.listenTimer = setTimeout(() => this.dispatch({ type: "cancel" }), LISTEN_TIMEOUT_MS);
    for (const fx of r.effects) this.run(fx);
    this.cb.onState(this.state);
    return r.effects;
  }

  private run(fx: VoiceEffect) {
    switch (fx.type) {
      case "stop-speaking": cancelSpeech(); break;
      case "submit": this.cb.onWake?.(); this.cb.onSubmit(fx.text); break;
      case "prompt": this.cb.onWake?.(); void this.say("Yes?"); break;
      case "greet": this.cb.onWake?.(); void this.say(greetingReply(fx.kind)); break;
      case "ignore": break;
    }
  }

  /** Speak a reply and drive the speaking/follow-up states. */
  async say(text: string) {
    if (this.state.phase === "off") return;
    this.replying = true;
    this.seg.reset(); // anything half-heard before Solo started talking is dropped
    this.resetInterrupt();
    this.dispatch({ type: "reply.start" });
    const s = this.settings();
    await speak(text, { voiceURI: s.voiceURI, rate: s.speechRate, gender: s.voiceGender });
    this.replying = false;
    this.muteUntil = Date.now() + TAIL_MS;
    this.resetInterrupt();
    // If an interruption already moved us to "listening", don't clobber it.
    if (this.state.phase === "speaking") this.dispatch({ type: "reply.end", now: Date.now(), followUpMs: this.settings().followUpSeconds * 1000 });
  }

  /** Stop talking now (UI button, or the owner interrupting). */
  stopSpeaking() {
    cancelSpeech();
    if (this.state.phase === "speaking") this.dispatch({ type: "barge-in" });
  }

  async start() {
    if (this.stream) return;
    await window.solo.voice.setMicAllowed(true);
    try {
      const s = this.settings();
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: s.inputDeviceId ? { exact: s.inputDeviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule(workletUrl);
      const src = this.ctx.createMediaStreamSource(this.stream);
      const node = new AudioWorkletNode(this.ctx, "solo-capture");
      const rate = this.ctx.sampleRate;
      this.seg.reset();
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => this.onFrame(resample(ev.data, rate, 16000));
      src.connect(node); // not connected to destination: we never play the mic back
      this.dispatch({ type: "mic.on" });
    } catch (e) {
      await this.stop();
      this.cb.onError(e instanceof Error ? e.message : String(e));
    }
  }

  async stop() {
    this.dispatch({ type: "mic.off" });
    this.cancelCapture(new Error("Microphone turned off"));
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    await this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
    this.seg.reset();
    this.resetInterrupt();
    await window.solo.voice.setMicAllowed(false);
  }

  // ---- enrolment: record the owner reading a sentence -----------------------------------------------------------

  /** Resolves with the next spoken phrase (16 kHz PCM) without transcribing or acting on it. */
  captureClip(timeoutMs = 25_000): Promise<Float32Array> {
    this.cancelCapture(new Error("Cancelled"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancelCapture(new Error("I did not hear anything. Check the microphone and try again.")), timeoutMs);
      this.capture = { resolve, reject, timer };
    });
  }
  cancelCapture(reason = new Error("Cancelled")) {
    const c = this.capture; this.capture = undefined;
    if (c) { clearTimeout(c.timer); c.reject(reason); }
  }

  // ---- microphone frames ----------------------------------------------------------------------------------------

  private resetInterrupt() { this.interruptFrames = []; this.interruptMs = 0; }

  private onFrame(frame: Float32Array) {
    const s = this.settings();
    const policy = micPolicy({ capturing: !!this.capture, speaking: this.replying, now: Date.now(), muteUntil: this.muteUntil, enrolled: this.enrolled, allowInterrupt: s.allowInterrupt });
    if (policy === "ignore") { this.seg.reset(); return; } // Solo never hears itself
    if (policy === "watch-interrupt") return this.onFrameWhileSpeaking(frame, s);

    const utt = this.seg.push(frame);
    if (!utt) return;
    if (this.capture) {
      const c = this.capture; this.capture = undefined; clearTimeout(c.timer); c.resolve(utt);
      return;
    }
    if (this.busy) return;
    this.busy = true;
    const strictness = s.strictness;
    void Promise.all([
      window.solo.voice.transcribe(utt),
      this.enrolled ? window.solo.voiceId.verify(utt, strictness) : Promise.resolve(undefined),
    ])
      .then(([raw, vid]) => {
        const text = applyCorrections(raw, this.settings().corrections).trim();
        if (!text) return;
        const owner = vid && vid.enrolled && !vid.tooShort ? vid.owner : undefined;
        const score = vid && vid.enrolled && !vid.tooShort ? vid.score : undefined;
        const fx = this.dispatch({ type: "utterance", text, now: Date.now(), owner });
        this.cb.onHeard(text, fx.some((f) => f.type === "submit" || f.type === "prompt" || f.type === "greet"), { owner, score });
      })
      .catch((e) => this.cb.onError(`Speech recognition failed: ${e instanceof Error ? e.message : e}`))
      .finally(() => { this.busy = false; });
  }

  /**
   * Solo is talking. Normally the microphone is ignored. If the owner's voice is enrolled and interruption is allowed,
   * watch for sustained speech and verify it is the owner before stopping Solo, so Solo's own voice (or a TV) cannot.
   */
  private onFrameWhileSpeaking(frame: Float32Array, s: VoiceSettings) {
    this.seg.push(frame);
    if (!this.seg.speaking) { this.resetInterrupt(); return; }
    this.interruptFrames.push(frame);
    this.interruptMs += (frame.length / 16000) * 1000;
    const maxFrames = Math.ceil((1.6 * 16000) / Math.max(1, frame.length));
    while (this.interruptFrames.length > maxFrames) this.interruptFrames.shift();
    const now = Date.now();
    if (this.interruptMs < INTERRUPT_MIN_MS || this.checkingInterrupt || now - this.lastInterruptCheck < INTERRUPT_CHECK_EVERY_MS) return;
    this.checkingInterrupt = true;
    this.lastInterruptCheck = now;
    const total = this.interruptFrames.reduce((n, f) => n + f.length, 0);
    const clip = new Float32Array(total);
    let o = 0; for (const f of this.interruptFrames) { clip.set(f, o); o += f.length; }
    void window.solo.voiceId.verify(clip, s.strictness)
      .then((v) => { if (v.enrolled && !v.tooShort && v.owner && this.replying) this.stopSpeaking(); })
      .catch(() => undefined)
      .finally(() => { this.checkingInterrupt = false; });
  }

  /** The reply for a submitted request has been produced elsewhere; speak it. */
  async reply(text: string) { await this.say(text); }
  /** Back to idle without speaking (e.g. a task finished silently). */
  finish() { if (this.state.phase === "thinking") this.dispatch({ type: "reply.end", now: Date.now(), followUpMs: this.settings().followUpSeconds * 1000 }); }
}
