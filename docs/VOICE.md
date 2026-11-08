# Solo - Knowing your voice, and your English

Status: built and measured with synthetic voices only. **Not yet measured with a real person's voice or with
Nigerian-accented speech.** Please read "What is and is not verified".

## 1. What was asked

1. Recognise the owner's voice, like a fingerprint: enrol once, then Solo answers "hello", "hi", "good morning" with no wake word, as long as it can hear the owner clearly.
2. Understand intent in English *and* Nigerian English, which are not the same.
3. Fix the desktop voice breaking in the middle of talking.

## 2. Recognising the owner

**How it works.** A speaker-verification model (WavLM-base-plus, ONNX, runs offline in the desktop app) turns speech into
512 numbers. Enrolment: the owner reads 5 sentences; Solo averages their numbers into a *voice print* and refuses the
enrolment if the recordings do not sound alike (for example, someone else spoke). Solo also adds noisy and faster/slower
copies of each recording to the print. Later, each utterance is embedded and compared with the print; at or above the
threshold it is the owner.

**What is stored.** Only the numbers (never audio), in `voiceprint.bin` in Solo's data folder, encrypted with the Windows
keystore (DPAPI via Electron `safeStorage`). It is not synced to any other device. "Delete my voice print" removes it.
If Windows cannot encrypt, Solo still stores it (file permissions only) and says so in the app.

**What it does for you** (all switchable):
- *Only respond to my voice* (default on once enrolled): other people cannot wake or command Solo, even by saying "Hey Solo".
- *Answer my greetings without a wake word* (default on): "hello", "hi", "good morning/afternoon/evening/night", and Nigerian greetings ("how far", "how you dey", "wetin dey") from the verified owner get a spoken, time-aware reply. Greetings aimed at other people ("hi mum", "good morning everyone") are ignored.
- *Let me interrupt Solo by talking* (default on): only the owner's voice can stop Solo mid-sentence.
- *Strictness* slider, and a **Test my voice** button that shows your live match score against the threshold, so you can tune it with your real voice.

**It is NOT a fingerprint.** A learned voice model has error rates in both directions, and a recording or a good synthetic
copy of the owner's voice can pass. It is a convenience gate ("answer me, not the TV or a visitor"). Solo never uses it to
approve a sensitive action; the confirmations planned for agent actions (Phase 6) do not depend on it.

### Measured accuracy (real model, real audio, synthetic voices)
Two Windows text-to-speech voices stood in for two people (David = owner, Zira = other). Enrolment: 5 sentences. Test: 4
unseen sentences each at 3 everyday speeds, plus stress tests. Threshold 0.785 (default strictness 0.25):

| Test | Owner accepted | Other voice accepted |
|---|---|---|
| Unseen sentences, everyday speed variation | 11/12 (mean score 0.89) | 0/12 (mean 0.52) |
| Very fast speech (about 1.7x) | 6/6 | 2/12 |
| One-second greetings ("Hello." / "Good morning." / "Hi there.") | 2/3 | 0/3 |
| Added noise at 30, 20, 10 and 5 dB SNR | 4/4 at every level | 0/4 at every level |

The same test before adding noise/speed augmentation to enrolment: noisy-room owner acceptance was 1/4, 0/4, 0/4, 0/4 and
very fast speech 2/6, so augmentation was worth keeping. The owner's lowest-scoring cases are the shortest clips: a bare
"Hello." can be missed; "Hello, Solo" or a full sentence is more reliable.

## 3. English and Nigerian English

- **Speech recognition model size** (Voice > Recognition accuracy): Fast (Whisper tiny.en, the default and the only one verified
  end to end), Better (base.en), Best (small.en). If a bigger model cannot be downloaded Solo falls back to Fast. Larger models handle accents better but are slower. Measured here on clean synthetic speech: Fast = 3.2 s per
  4.7 s utterance (0.68x real time), 2.4% word error rate. *Better* and *Best* are NOT measured: their downloads kept dropping on this
  connection (twice at about 20 MB), so I have not seen them run at all. Expect them to be slower; accuracy gain on accents is
  the general expectation for larger Whisper models, not something I measured.
- **Words Solo should fix:** teach Solo what it mishears ("sorry low" -> "Solo"); applied before wake and intent decisions.
  Corrections stay on this PC.
- **Intent layer** (`packages/shared/src/language.ts`): a small, rule-based Nigerian English / Pidgin normaliser ("abeg open
  vs code" -> "please open vs code"; "wetin dey happen" -> "what is happening"; "I no fit find the file" -> "I cannot find the
  file"), greeting detection, and a coarse intent classifier (greeting / question / command / statement) so ordinary talk is
  not turned into tasks. It is a starter lexicon, **not** an understanding of Pidgin grammar. Real interpretation of meaning
  will come from the conversational model (Phase 4), which will be told the user speaks Nigerian English.
- **Not measured:** how well Whisper transcribes Nigerian-accented speech or Pidgin. There is no such audio on this machine
  and I cannot produce a trustworthy imitation. Use *Recently heard* to see what Solo thinks you said; use "Fix" to teach it.

## 4. The voice that "breaks mid-talk"

Findings:
- I tested the suspected Chromium problem (speech cut off when the speech object is garbage-collected) in the real Electron
  runtime with forced garbage collection and long text: **not reproduced**; both variants finished. It was cheap to defend
  against anyway, so utterances are now held until finished and replies are spoken sentence by sentence.
- The more likely cause (found by reading the code, not reproduced acoustically): Solo repeated what you said, including
  "Solo", and the microphone heard its own voice and treated it as a new wake word or an interruption, which stops speech.
  Fixed three ways: the microphone is ignored while Solo speaks and for 0.6 s after (`micPolicy`, unit-tested); Solo's echo
  reply never says "Solo"; and the only thing that can interrupt it is your enrolled voice, sustained for about a second
  and verified. Without a voice print there is no voice interruption (a speaker cannot tell a person from Solo's own voice).
- I could not reproduce the problem acoustically here. If it still happens, tell me what you were doing and what Solo was
  saying when it broke; the next step would be logging the engine's events during a real session.

## 5. What is and is not verified

Verified: voice-print maths and storage (unit tests: enrolment rules, inconsistent recordings refused, encryption at rest,
restart, deletion, other-model prints ignored); the owner-gating state machine (the owner's greeting works, others and
unverifiable audio are ignored, follow-ups need the owner, switches work); the "never hears itself" microphone policy;
sentence splitting; the numbers in section 2 with the real model.

Not verified: any real person's voice (accuracy for you is unknown; use *Test my voice*); Nigerian-accented or Pidgin
recognition; the enrolment and settings screens used by a person (built and type-checked; screenshot only); the microphone
interruption path with real acoustics; behaviour with the microphone near the speakers; spoofing resistance (none claimed);
phone items listed in section 6; model licences (WavLM-base-plus-sv: check before public release).

## 6. The phone does the same (parity)

Everything in sections 2 and 3 exists on the Android app too, written natively in Kotlin (same maths, same thresholds):
*Settings > My voice* (five-sentence enrolment, only-my-voice, greetings without a wake word, owner-only interruption,
strictness, Test my voice, delete) and *Words Solo should fix*. The wake-word service checks the speaker after Vosk hears a
phrase, and ignores people who are not you.

How it differs from the desktop:
- **Speech engine**: Vosk (small English model), not the Whisper sizes. No "Better/Best" choice on the phone.
- **Speaker model**: the same WavLM model, run with ONNX Runtime. The app is about 100 MB larger. The voice print is encrypted
  with the Android Keystore and never leaves the phone; the desktop and phone prints are separate and not synced.
- **Corrections** are kept per device and are not synced.

Verified (JVM, same real model and same audio as the desktop): genuine 11/12 accepted (mean 0.886, desktop 0.887),
impostor 1/12 accepted (mean 0.516, desktop 0.516), enrolment agreement 0.785 / 0.877 (desktop 0.790 / 0.880).
Unit tests cover the maths, storage and language rules; Flutter widget tests cover the screens.
A bug found on the way: the first Kotlin version normalised the waveform, but this model's own feature extractor does not
(`do_normalize: false`); enrolment was refused until that was fixed.

Not verified: speed and accuracy on a real phone (enrolling runs about 25 embeddings; on a PC JVM that took 40 s), the
wake-word service with owner checking on a real handset (battery limits, Huawei background rules), real voices, Nigerian
accents, and the acoustic path from speaker to microphone.
