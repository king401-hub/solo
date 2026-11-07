import { Segmenter, initialVoice, resample, stepVoice, type VoiceEffect, type VoiceEvent, type VoiceSettings, type VoiceState } from "@solo/shared";
import workletUrl from "./capture-worklet.js?url";
import { cancelSpeech, speak } from "./tts";

const LISTEN_TIMEOUT_MS = 8000; // after "Hey Solo" alone, how long we wait for the request

export interface EngineCallbacks {
  onState(s: VoiceState): void;
  /** A finished, accepted request (wake word stripped). Phase 4 routes this to the conversational AI. */
  onSubmit(text: string): void;
  /** Everything Whisper heard, even if ignored (for the on-screen log; never leaves the device). */
  onHeard(text: string, accepted: boolean): void;
  onError(msg: string): void;
}

/**
 * Microphone -> segmenter -> local Whisper (via IPC) -> wake word / state machine.
 * Audio only leaves the audio thread when the segmenter finds speech; it is sent to the local main process only,
 * never to a network service. stop() releases the microphone (the OS indicator goes off).
 */
export class VoiceEngine {
  private state: VoiceState = initialVoice;
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private seg = new Segmenter();
  private busy = false;
  private listenTimer?: ReturnType<typeof setTimeout>;
  private replying = false;

  constructor(private cb: EngineCallbacks, private settings: () => VoiceSettings) {}

  get phase() { return this.state.phase; }

  private dispatch(e: VoiceEvent): VoiceEffect[] {
    const cfg = { wakeWords: this.settings().wakeWords, quickWord: this.settings().quickWord };
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
      case "submit": this.cb.onSubmit(fx.text); break;
      case "prompt": void this.say("Yes?"); break;
      case "ignore": break;
    }
  }

  /** Speak a reply and drive the speaking/follow-up states. */
  async say(text: string) {
    if (this.state.phase === "off") return;
    this.replying = true;
    this.dispatch({ type: "reply.start" });
    await speak(text, { voiceURI: this.settings().voiceURI, rate: this.settings().speechRate, gender: this.settings().voiceGender });
    this.replying = false;
    // If barge-in already moved us to "listening", don't clobber it.
    if (this.state.phase === "speaking") this.dispatch({ type: "reply.end", now: Date.now(), followUpMs: this.settings().followUpSeconds * 1000 });
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
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    await this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
    this.seg.reset();
    await window.solo.voice.setMicAllowed(false);
  }

  private onFrame(frame: Float32Array) {
    const utt = this.seg.push(frame);
    // Speech starting while Solo talks = barge-in (echo cancellation keeps Solo's own voice from triggering this).
    if (this.seg.speaking && this.state.phase === "speaking" && this.replying) this.dispatch({ type: "barge-in" });
    if (!utt || this.busy) return;
    this.busy = true;
    void window.solo.voice
      .transcribe(utt)
      .then((text) => {
        if (!text) return;
        const fx = this.dispatch({ type: "utterance", text, now: Date.now() });
        this.cb.onHeard(text, fx.some((f) => f.type === "submit" || f.type === "prompt"));
      })
      .catch((e) => this.cb.onError(`Speech recognition failed: ${e instanceof Error ? e.message : e}`))
      .finally(() => { this.busy = false; });
  }

  /** The reply for a submitted request has been produced elsewhere; speak it. */
  async reply(text: string) { await this.say(text); }
  /** Back to idle without speaking (e.g. a task finished silently). */
  finish() { if (this.state.phase === "thinking") this.dispatch({ type: "reply.end", now: Date.now(), followUpMs: this.settings().followUpSeconds * 1000 }); }
}
