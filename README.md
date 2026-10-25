# Jellyfin Party Play

A private watch-together web app for a Jellyfin library. Pick a title, get an 8-character room code, and everyone with the code watches the same thing in sync. Anyone in the room can play, pause or seek and it applies to all. There is a side chat, and a "back 15 s for everyone" button.

Each viewer's browser plays straight from Jellyfin. A small room server keeps one shared timeline, so no viewer's video element is ever the reference and a laggy viewer cannot stutter anyone else.

## How it works

- **Server-authoritative timeline.** The room server holds the item, an anchor position, an anchor server time and a playing/paused flag. Commands are numbered with a monotonic version and stamped with a future execution time (play +1000 ms, pause/seek +300 ms); late or out-of-order commands are dropped.
- **Clock sync** per client: ping/pong, last 8 samples, lowest RTT wins, EMA smoothing.
- **Drift ladder** per client: under 0.3 s ignore, 0.3 to 2 s nudge `playbackRate` by at most 5%, over 2 s hard seek with a cooldown. Seeks aim ahead by the measured seek time, so slow remux seeks land on the beat.
- **Stall policy.** If a viewer's player stalls, the room pauses for everyone, names who is buffering with a 10 s countdown, and resumes together when they recover (or carries on without them).
- **Echo guard** so a viewer's own player events are not mistaken for commands.
- **Player.** Custom controls (the browser's own can't show overlays): play/pause, 15 s rewind and skip that move the whole room, a seek bar, mute, and fullscreen. On Safari, "fullscreen" fills the page instead of using browser fullscreen, because Safari blocks typing there and chat needs it.
- **Subtitles.** Text tracks from Jellyfin (embedded or external) are listed in a per-viewer picker and remembered per device. They are fetched through the app's server as WebVTT, which keeps the Jellyfin token out of the page. The first request for an embedded track can take half a minute while Jellyfin extracts it, so the English track is warmed in the background. Picture subtitles (PGS) cannot be shown by a browser and are not listed.
- **Fullscreen chat.** New messages pop up over the picture while the chat is closed, a tab on the right edge slides the chat over the video, and a pin keeps it there. It is an overlay, so the video is never resized.
- **Reactions.** Six line-icon reactions float up over everyone's picture (no emoji, per the design system). Rate-limited, not stored.
- **Playback check.** `/diag` tests what a browser can decode (H.264, HEVC 8- and 10-bit) and how fast a real heavy stream arrives over that connection, and writes the results to the web service log. Rooms also warn up front when the browser cannot decode a title's video. When a viewer stalls, the room server logs who stalled and how it ended.
- **Audio tracks.** Titles with more than one audio track get an audio picker next to the subtitles button. Each viewer chooses their own; choosing asks Jellyfin for a stream with that track (always the repackaged stream, with the video still copied) and resumes where the room is. The choice is remembered per device and applied automatically on titles that offer that language.
- **Stats readout.** Add `?stats=1` to a room address to see drift, playback rate, buffer, dropped frames, seek time and counters, for diagnosing playback on a device.
- **Persistence.** Rooms, last position and chat live in SQLite and are deleted 3 days after last use. Reopening a code resumes the film where it stopped, paused.
- **Direct play first, never a video re-encode.** MP4 plays as is. MKV plays through Jellyfin's own live remux (HLS, video stream copied); the app refuses any plan in which Jellyfin would re-encode video or burn in subtitles. Titles that cannot be played that way are greyed out with a plain-words reason.

Stack: Next.js (App Router), Tailwind CSS, Framer Motion, Zustand, a Node/TypeScript room server (`ws`, `better-sqlite3`), hls.js for browsers without native HLS.

The sync design (clock sync, scheduled actions, echo guard, limits, message names) is ported to TypeScript from [OpenWatchParty](https://github.com/mhbxyz/OpenWatchParty) (MIT). See `NOTICE`.

## Requirements

- Node 20+
- A Jellyfin server (developed against 12.x) with a dedicated user for this app
- The media must be readable on the machine running the app if you use `LIBRARY_ROOT` (used to hide entries whose files are gone)

## Setup

```bash
npm install --legacy-peer-deps
cp .env.example .env && chmod 600 .env   # then fill it in
npm run build
npm run server        # room server (port 3181)
npm start             # web app (port 3180)
```

### Jellyfin user

Create a user for the app with access only to the libraries you want to share. Under Playback:

- Allow video playback that requires **conversion without re-encoding**: **on** (live remux of MKV)
- Allow **video** playback that requires transcoding: **off**
- Allow audio playback that requires transcoding: off, unless you set `ALLOW_AUDIO_CONVERT=true` (AC3/EAC3 audio converted to AAC)

Authenticate that user once to get its token and id (Jellyfin 12 only accepts the `Authorization: MediaBrowser ..., Token="..."` header style), then put `JELLYFIN_TOKEN` and `JELLYFIN_USER_ID` in `.env`. Without them the app shows a small mock library of test cards.

Note that the stream URL handed to a viewer's browser carries that user's token, which is why the user should be low-privilege.

### Deploying

After every `npm run build`, restart the web service straight away. A running server remembers the file names from when it started, so a rebuild underneath it makes open pages fail with `ChunkLoadError` (400s on `_next/static` files) until it is restarted. Tests build into their own folder (`npm run build:test`, then `npm run e2e`) so they never disturb the build a running server is using.

`deploy/` has systemd units for the two services and a Cloudflare Tunnel config template (the `/ws` path routes to the room server, everything else to the web app). Replace the `YOUR_USER`, path and hostname placeholders before use. The room server must be reachable at `/ws` on the same host as the web app, or set `WS_PUBLIC_URL`.

## Tests

```bash
npm test             # unit tests: timeline, clock, drift, ordering, stall policy, retention
npm run typecheck
npm run build && npm run e2e   # Playwright: two browsers, stall, chat survives a restart, limits
npm run scan         # fails if any secret from .env appears in the client bundle
npm run playbackinfo # table of container/codecs/direct-play for a sample of your library
```

Generate the test videos once (needs ffmpeg; `data/` is not committed):

```bash
mkdir -p data
ffmpeg -y -f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 180 -c:v libvpx -b:v 300k -g 25 -c:a libvorbis -b:a 48k data/test.webm
ffmpeg -y -f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i sine=frequency=440:sample_rate=44100 -t 180 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -g 25 -c:a aac -movflags +faststart data/test.mp4
npx playwright install chromium
```

The end-to-end tests use a WebM stand-in served by the mock library (`data/test.webm`, generated with ffmpeg), because Playwright's Chromium cannot decode H.264 or HEVC. They do not exercise real Jellyfin playback.

## Design

`DESIGN-SYSTEM.md` records the decisions and visual tokens (Bebas Neue and Inter, a navy palette, a strict 64/40/28/18/14 px type scale, a ticket-style room code).
