import { defineConfig } from "@playwright/test";

try {
  process.loadEnvFile(".env");
} catch {
  /* tests need .env for the passcode and internal secret */
}

export const WEB_PORT = 3190;
export const ROOM_PORT = 3191;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  // NO_WEB=1 runs the tests that only need the room server (no web build, no browser).
  webServer: process.env.NO_WEB
    ? undefined
    : {
    // Serves the separate test build (npm run build:test), never the build the live server is using.
    command: `NEXT_DIST_DIR=.next-test npx next start -p ${WEB_PORT}`,
    url: `http://127.0.0.1:${WEB_PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ROOM_SERVER_URL: `http://127.0.0.1:${ROOM_PORT}`,
      WS_PUBLIC_URL: `ws://127.0.0.1:${ROOM_PORT}/ws`,
      // Playwright's Chromium has no H.264, so the test build serves a WebM stand-in.
      MOCK_VIDEO_FILE: "data/test.webm",
      JELLYFIN_TOKEN: "",
      JELLYFIN_USER_ID: "",
    },
  },
});
