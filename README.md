# 🎙️ Recording Assistant

A **guided evidence-capture and validation system**: it converts an accountability requirement into a controlled, continuous, tamper-evident recording workflow, tells the participant exactly what to do, verifies the required conditions stay satisfied, rejects invalid sessions, and produces a sealed verification packet for the Accountability Partner.

The system runs in two modes:

- **Offline** — one file, `index.html`. Download it, double-click it, done. Delivery is manual (download/share the packet, text the seal code).
- **Hosted** — add `server.js` (zero dependencies, `node server.js`) for **automatic delivery**: pairing codes, server-witnessed seal timestamps, a partner inbox the packets upload into on their own, and optional webhook notifications.

Both the participant **and** the partner use the same app (the partner uses the *Verify Packet* and *Hosted* tabs).

## How it works

### 1. Requirements
A requirement defines what a valid session is: video or audio, minimum duration, ordered instruction steps, and validity rules (max time hidden, max time camera obscured, silence limits, all-steps-required). The Accountability Partner can author a requirement in the app, **export** it as a JSON file, and send it to the participant to **import**. Every requirement has a SHA-256 fingerprint that appears in every packet, so the partner can confirm the right requirement was followed.

### 2. Sessions (participant)

Two session types:

**Guided task** — the app walks the participant through each step in order.

**Position hold (e.g. corner time)** — after the steps, the participant gets into position on camera and presses **Lock position**. From the lock:
- the **hold timer** starts (the minimum duration counts from the lock, not from recording start)
- **movement checking**: frame-to-frame motion analysis with a configurable budget (total movement seconds and max continuous movement) — exceeding it invalidates
- **position checking**: every frame is compared against the locked reference view; leaving the position beyond the allowed seconds invalidates. The comparison is mean-centered so lighting/exposure drift doesn't count as movement
- motion and deviation scores are sampled into the tamper-evident event log every 5s, and the verify report renders them as a **movement/position timeline** with the violation thresholds drawn in
- hashed snapshots are taken frequently (default every 15s) so the partner can visually confirm the pose in seconds
- **AI pose verification (optional)**: a requirement can additionally demand specific postures, verified continuously with the MoveNet pose model running entirely on the participant's device — **facing away from the camera (into the corner)**, **standing**, **kneeling**, and/or **hands on head**. Each pose gets a grace period (default 5s) before a lapse becomes a violation; pose pass/fail is sampled into the sealed event log every 5s, and the verify report shows a per-pose green/red strip with % held. If pose verification is required and the model cannot load, the session is invalid — it can't be bypassed by blocking the model.

**Every video session records with a burned-in overlay**: the recording is composited through a canvas (`canvas.captureStream()` + the raw mic track), so name, project, day number, date/time, challenge code, and live session/hold timers are drawn **into the pixels** of every frame — not metadata, not CSS. Capture is 1080p (long takes ~1.8 Mbps, short takes ~4 Mbps), and audio is raw: `echoCancellation`, `noiseSuppression`, and `autoGainControl` are all off, because speech-synthesis narration exists only as sound in the room and echo cancellation classifies it as speaker bleed and deletes it. A requirement can demand audible narration — a session that records silence is then invalid.

**Challenge codes (hosted mode)**: before recording starts, the app requests a single-use code from the server, timestamped and burned into every frame. Footage carrying the code cannot predate its issuance, and the server refuses to let a second session reuse it — the anti-backdating anchor for the whole record. At seal registration the whole-file SHA-256 **and** the rolling chain final are attested to the server together.

In both types, recording is **continuous — there is no pause**. While recording, the app live-monitors:

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

## Usage — offline mode

1. Download `index.html` and open it (Chrome or Edge recommended; Firefox/Safari also work).
2. **Partner:** create the requirement in the *Requirements* tab → *Export* → send the JSON to the participant. Keep a copy.
3. **Participant:** *Import* the requirement → *Record Session* → follow the steps → at completion, **immediately text the seal code to the partner**, then deliver the packet zip.
4. **Partner:** *Verify Packet* → enter the seal code you received → drop the zip in → read the report.

## Usage — hosted mode (automatic delivery)

### Run the server

```bash
node server.js          # Node 18+, zero dependencies, nothing to install
# → http://localhost:8787
```

Configuration via environment: `PORT` (default 8787), `DATA_DIR` (default `./data` — holds pairings, seals, and delivered packets; survives restarts). Deploy `server.js`, `index.html`, and the `vendor/` directory (bundled TF.js + MoveNet pose model, ~6 MB, so pose verification works offline) to any Node host — Render, Railway, Fly, a VPS — and put it behind HTTPS. The app is served by the server itself, so everyone just opens the URL. (An `index.html` opened as a local file can also point at a remote server via the *Hosted* tab's Server URL field.)

### Flow

1. **Partner:** open the app from the server → *Hosted* tab → *Create a pairing* (pick the requirement, optionally set a webhook URL for Slack/Discord/Zapier notifications) → send the generated **pairing code** to the participant.
2. **Participant:** *Hosted* tab → paste the pairing code → *Connect*. The requirement imports automatically.
3. **Participant:** run sessions normally. At completion the app **automatically registers the seal with the server** (a trusted timestamp, replacing the text-the-code step) **and uploads the packet to the partner's inbox**, with retries; failed deliveries can be retried from *History*.
4. **Partner:** *Hosted* tab shows each pairing's inbox — every session with its seal-registration time, delivery time, and claimed verdict. One click on **Verify now** fetches the packet, auto-fills the server-witnessed seal code, and runs the full integrity verification.

### What hosting adds, precisely

- **Automatic delivery** — no manual download/share/text steps; the packet lands in the partner's inbox the moment the session completes, and a webhook can announce it.
- **A trusted timestamp witness** — the server records the seal (with an HMAC receipt) the instant the session completes and refuses to ever change it; a packet upload is only accepted if it matches a registered seal, and both are immutable per session. This closes the offline mode's main gap: a participant can no longer discard an attempt and quietly re-record before "sending the code", because the first seal for a session is on the record with a server timestamp — and gaps (seals with no packet, long delays between sealing and delivery) are visible to the partner.
- **Auth by capability keys** — the pairing code authorizes only the participant actions (fetch requirement, register seal, upload packet); the partner key authorizes only reading the inbox and downloading packets. No accounts or passwords to manage.

### API surface (for integrations)

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/pairings` | partner | create pairing (requirement + optional webhook) |
| `GET /api/pairings/:id?key=` | partner | pairing info + inbox |
| `GET /api/requirement?code=` | participant | fetch the paired requirement |
| `POST /api/seals` | participant | register a session seal (immutable, timestamped, HMAC receipt) |
| `PUT /api/packets/:sessionId?code=` | participant | upload the packet zip (requires registered seal; immutable) |
| `GET /api/packets/:sessionId?pairId=&key=` | partner | download a delivered packet |

## Honest limitations

The guarantees are precise but bounded:

- **What it proves:** the delivered bytes are exactly what was captured, in one continuous take, under the logged conditions, with the logged violations — and that the packet wasn't rebuilt after sealing (offline: via the out-of-band seal code; hosted: via the server-witnessed, immutable seal record).
- **What it can't prove:** who is on camera, or what's happening off-camera. A determined participant could point the camera at a screen. The requirement's steps (state name/date aloud, pan surroundings, one-take confirmation) are the mitigation — design them accordingly. Hosted mode makes discard-and-redo *visible* (abandoned seals and delays appear in the inbox) but the partner still needs to look.
- **Pose verification is a heuristic on top of an ML model.** MoveNet keypoint estimation is good but not perfect — poor lighting, unusual camera angles, or partial occlusion can cause misses, which is why each pose has a grace period and why the hashed snapshots remain the authoritative visual record. The pose rules (standing/kneeling/hands-on-head/facing-away) are geometric heuristics over the 17 detected keypoints, not a certified biometric system.
- **The pose model needs to load from somewhere.** Served by `server.js`, the model is bundled (`vendor/`) and works fully offline. Opened as a bare local file, the app falls back to loading TF.js and the model from the internet (jsDelivr/TFHub); no video ever leaves the device either way — inference is 100% local.
- The server is a *timing witness and courier*, not an identity authority: anyone holding the pairing code can submit sessions. Share codes over a private channel.
- It is not a substitute for professional court-ordered monitoring systems where those are required.

## Development

No build step — edit `index.html` / `server.js` and refresh/restart. Test suites (crypto, zip format, hash chain, verdict engine, and a full server integration flow) run under plain Node.
