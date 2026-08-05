# 🎙️ Recording Assistant

A **guided evidence-capture and validation system**: it converts an accountability requirement into a controlled, continuous, tamper-evident recording workflow, tells the participant exactly what to do, verifies the required conditions stay satisfied, rejects invalid sessions, and produces a sealed verification packet for the Accountability Partner.

The entire system is one file — `index.html`. Download it, double-click it, and it runs in your browser. No install, no server, no account. Both the participant **and** the partner use the same file (the partner uses the *Verify Packet* tab).

## How it works

### 1. Requirements
A requirement defines what a valid session is: video or audio, minimum duration, ordered instruction steps, and validity rules (max time hidden, max time camera obscured, silence limits, all-steps-required). The Accountability Partner can author a requirement in the app, **export** it as a JSON file, and send it to the participant to **import**. Every requirement has a SHA-256 fingerprint that appears in every packet, so the partner can confirm the right requirement was followed.

### 2. Guided session (participant)
The app walks the participant through each step in order. Recording is **continuous — there is no pause**. While recording, the app live-monitors:

- **Recording continuity** — mic/camera disconnection ends and invalidates the session
- **Screen presence** — hiding/backgrounding the app beyond the allowed window invalidates
- **Camera obstruction** — dark/covered camera beyond the allowed window invalidates (video mode)
- **Silence** — optional rule for extended silence
- **Clock consistency** — wall-clock vs. monotonic-clock drift is logged
- **Steps** — each instruction must be marked done, in order, with timestamps
- **Interruption** — closing/reloading the page mid-session invalidates it

Every event is timestamped into a session log. Violations are announced on screen the moment they happen.

### 3. Tamper evidence
- Every 2-second media chunk is folded into a **SHA-256 hash chain** *as it is captured* — the chain commits to every byte, in order.
- Camera **snapshots** are taken every 30 seconds and hashed.
- The event log is hashed; everything is combined into a final **integrity seal**.
- A short **seal code** (derived from the seal) is shown at completion. The participant sends it to the partner immediately via a *separate channel* (text message / call). That out-of-band code is what makes rebuilding the packet after the fact detectable.

### 4. Validation & rejection
At completion the verdict is computed: too short, aborted, missed steps, or any rule violation → the session is **REJECTED (INVALID)** with explicit reasons and must be redone. Invalid packets are still produced and kept, clearly marked, as a record of the attempt.

### 5. Verification packet & delivery
Each session produces one `.zip`:

```
packet_<requirement>_<timestamp>_<VALID|INVALID>.zip
├── README.txt          — instructions for the partner
├── manifest.json       — requirement, timing, event log, hashes, verdict, seal
├── recording.webm      — the continuous recording
└── snapshots/*.jpg     — periodic hashed camera frames
```

Deliver it by download or the device share sheet (email, drive, messaging). The partner opens the same app → **Verify Packet** → drops the zip in. The app then, from raw bytes and trusting nothing the packet claims:

1. Recomputes the media SHA-256 and replays the full capture-time hash chain (any single changed byte fails)
2. Re-verifies every snapshot hash and the event-log hash
3. **Re-derives the verdict independently** from the event log + the requirement's rules and compares it to the packet's verdict
4. Recomputes the requirement fingerprint and the integrity seal
5. Compares the seal code against the one the partner received directly from the participant

It then shows a full pass/fail report, the recording, the snapshots, and the complete event timeline.

## Usage

1. Download `index.html` and open it (Chrome or Edge recommended; Firefox/Safari also work).
2. **Partner:** create the requirement in the *Requirements* tab → *Export* → send the JSON to the participant. Keep a copy.
3. **Participant:** *Import* the requirement → *Record Session* → follow the steps → at completion, **immediately text the seal code to the partner**, then deliver the packet zip.
4. **Partner:** *Verify Packet* → enter the seal code you received → drop the zip in → read the report.

## Honest limitations

This is a client-side tool with no server and no shared secret, so its guarantees are precise but bounded:

- **What it proves:** the delivered bytes are exactly what was captured, in one continuous take, under the logged conditions, with the logged violations — and (via the out-of-band seal code) that the packet wasn't re-recorded or rebuilt after the seal code was sent.
- **What it can't prove:** who is on camera, or what's happening off-camera. A determined participant could point the camera at a screen, or complete an entire fresh session before sending a seal code. The requirement's steps (state name/date aloud, pan surroundings, one-take confirmation) are the mitigation for this — design them accordingly.
- It is not a substitute for professional court-ordered monitoring systems where those are required.

## Development

No build step — edit `index.html` and refresh. Logic tests for the crypto, zip format, hash chain, and verdict engine live in the session scratchpad (`test.js`) and run under Node.
