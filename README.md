# 🎙️ Recording Assistant

A **guided evidence-capture and validation system**: it converts an accountability requirement into a controlled, continuous, tamper-evident recording workflow, tells the participant exactly what to do, verifies the required conditions stay satisfied, rejects invalid sessions, and produces a sealed verification packet for the Accountability Partner.

The system runs in two modes:

- **Offline** — one file, `index.html`. Download it, double-click it, done. Delivery is manual (download/share the packet, text the seal code).
- **Hosted** — add `server.js` (zero dependencies, `node server.js`) for **automatic delivery**: pairing codes, server-witnessed seal timestamps, a partner inbox the packets upload into on their own, and optional webhook notifications.

Both the participant **and** the partner use the same app (the partner uses the *Verify Packet* and *Hosted* tabs).

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

Configuration via environment: `PORT` (default 8787), `DATA_DIR` (default `./data` — holds pairings, seals, and delivered packets; survives restarts). Deploy the two files (`server.js`, `index.html`) to any Node host — Render, Railway, Fly, a VPS — and put it behind HTTPS. The app is served by the server itself, so everyone just opens the URL. (An `index.html` opened as a local file can also point at a remote server via the *Hosted* tab's Server URL field.)

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
- The server is a *timing witness and courier*, not an identity authority: anyone holding the pairing code can submit sessions. Share codes over a private channel.
- It is not a substitute for professional court-ordered monitoring systems where those are required.

## Development

No build step — edit `index.html` / `server.js` and refresh/restart. Test suites (crypto, zip format, hash chain, verdict engine, and a full server integration flow) run under plain Node.
