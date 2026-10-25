# DESIGN-SYSTEM.md — Watch Party (working name)

Status: DRAFT. Step 1 (architecture) decisions recorded. Steps 2-4 pending Yousuf's answers.

## 1. Goal
Pick any title from the existing Jellyfin library, get a room code, everyone with the code watches the same thing in sync. Anyone in the room can play, pause or seek and it applies to all. Side chat. A laggy viewer must never stutter anyone else.

## 2. Decisions so far
| # | Decision | Why |
|---|----------|-----|
| 1 | Custom build, borrowing design from OpenWatchParty (MIT) | Fork is host-only, host-as-truth, built for HLS. Our needs differ. |
| 2 | Room server in Node/TypeScript (not Rust) | One language with the web app. Rust compile on QuackBox (i5-5200U) is slow. |
| 3 | Web app AND room server both run on QuackBox, behind the Cloudflare tunnel | One place to debug, same machine as Jellyfin. |
| 4 | Joining: anyone with the room code (no login). Creating rooms and browsing /library: one shared passcode, entered once per device | Yousuf's choice (option a). Keeps strangers out of the library. |
| 8 | App name: "Y - S Movie Night" | Yousuf's choice. |
| 9 | Stall policy: the room WAITS for a stalled viewer and shows a visible note naming who is buffering | Yousuf's choice. Cap on the wait: OPEN QUESTION (see 7). |
| 10 | Design tone: a bit playful, no emojis, no vibecoded elements | Yousuf's choice. |
| 11 | No legal pages (privacy policy, terms of service) | Private app, just Yousuf and Simra. |
| 12 | Chat history is KEPT (saved on the server, not in the browser) | Yousuf's choice. Retention length and storage: OPEN QUESTION (see 7). |
| 13 | Favicon and styled 404 stay (small, cheap); contact/owner text not needed | Assumed from "we don't need any of those". |
| 14 | Chat, last position and room record kept 3 days after last use, then deleted | Yousuf's choice. Stored in SQLite on QuackBox only. |
| 15 | Room code works as a bookmark inside the 3-day window (reopen = old chat + resume position) | Default chosen after Yousuf answered "eh". |
| 16 | Favicon: two tickets, line mark #F5EFEB on #17222C | Yousuf's choice. |
| 5 | Jellyfin already reachable from outside via tunnel | Confirmed by Yousuf. |
| 6 | Each browser plays directly from Jellyfin (direct play only) | Upload is the bottleneck; no transcoding. |
| 7 | Dedicated low-privilege Jellyfin user, transcoding disabled | Limits damage from a stream token living in the video URL. |

## 3. Stack (from standing preferences)
Next.js, Tailwind CSS, Framer Motion, Lucide. Zustand for the client mirror of server state. WebSocket (ws) for the room server. Deployed on QuackBox (not Vercel) per decision 3.

## 4. Routes
Public: `/` (landing + join by code), 404. No `/privacy-policy` or `/terms-of-service`: private app for two people (Yousuf's decision), revisit if it ever opens to others.
Gated: `/library` (browse and pick), `/room/[code]` (player, chat).
Gating rule: `/library` and room creation require the shared passcode (stored as a hashed server-side session cookie, never in client files). `/room/[code]` requires only the code.

## 5. Sync model (server-authoritative timeline)
- Room state on the server: item, anchor position, anchor server time, playing/paused, rate 1.
- Expected position = anchor + (serverNow - anchorTime) if playing.
- No viewer's `<video>` is ever the source of truth.
- Commands (play/pause/seek) from ANY member are numbered by the server, stamped with a future execution time (play +1000 ms, pause/seek +300 ms; from OpenWatchParty), and broadcast.
- Clock offset per client: ping/pong, keep last 8 samples, trust lowest-RTT, smooth (from OpenWatchParty).
- Drift per client: under 0.3 s ignore; 0.3-2 s nudge playbackRate by at most +/-5%; over 2 s hard seek.
- Stall policy (decided): when a viewer's player stalls, the room pauses and shows a note ("X is buffering"). When they recover, play resumes together. A stalled viewer never causes drift: the timeline is paused while they catch up. Maximum wait: 10 seconds (decided), then the room continues without them; they rejoin by seeking to the timeline position when ready. The note stays visible for the whole wait, e.g. "Simra is buffering. Continuing in 7."
- Echo guard: ignore the video's own pause/play events for 2 s after applying a server command, and ignore pause events while buffering (from OpenWatchParty).
- Rooms survive the creator leaving. With chat history kept, a room is a saved record (item, last position, chat) that can be reopened by its code. How long records are kept: OPEN QUESTION (see 7).

## 6. Security
- Jellyfin admin credentials and any app secrets stay on the server, never in browser-accessible files.
- Browser receives only a stream URL/token for the dedicated limited user, and only after joining a room.
- Room codes: 8 characters from a 32-letter alphabet (about 40 bits), rate-limited join attempts, rooms expire.
- Rate limits and size limits ported from OpenWatchParty (30 msg/s, 64 KB messages, 500-char chat).
- Attribution: keep OpenWatchParty's MIT notice in the repo for ported logic.

## 7. Open questions
1. (Resolved) Shared passcode for creating and browsing.
2. (Resolved) Stall wait cap: 10 seconds.
3. (Resolved) App name.
4. Typical titles' Playback Info: checked against the real Jellyfin library with `npm run playbackinfo`, which reports direct-play compatibility.
5. Devices Simra uses (iPhone Safari quirks): treat iPhone Safari as a supported target; test fullscreen, autoplay (tap-to-join), playsinline.

## 8. Build order (from workflow)
Structure -> Components -> Backend/State -> Responsive UI -> Legal/Error pages -> Polish -> Deploy.
Pause for review at every step.

## 9. Visual tokens (to be confirmed at step 2)
Decision (Yousuf): reuse WaddleTV's look. This replaces the cream palette and Space Grotesk from the standing preferences for this project. Source: master-quack/waddleTV, frontend/src/index.css.

Fonts: Bebas Neue (display/headlines), Inter 400/500/600/700 (body), via Google Fonts (next/font in Next.js so nothing loads from a third party at runtime).

Colors (WaddleTV dark theme):
| Token | Value | Use |
|-------|-------|-----|
| --bg | #17222C | page background (about 60%) |
| --surface | #2F4156 | cards, panels |
| --surface-raised | #3B5268 | hovered/raised panels |
| --text | #F5EFEB | main text |
| --text-muted | #9FB3C0 | secondary text |
| --accent | #C8D9E6 | key moments only (about 10%) |
| --accent-dim | #7D93A3 | quiet accents |
| --border | #567C8D | hairlines |
| --danger | #E88A85 | errors |
WaddleTV also defines a lighter variant (bg #2F4156); not used unless asked.

Sizes: strict set 64/40/28/18/14 px only (confirmed, applies with Bebas Neue). Ticket-style room code and writing-led playfulness confirmed.
Tone: playful through writing and small motion; no emojis, gradients, glows, glassmorphism or blobs.
