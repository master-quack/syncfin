import type { LibraryItem } from "./jellyfin";

// Stand-in library used until a Jellyfin user for this app is configured in .env.
export const MOCK_ITEMS: LibraryItem[] = [
  { id: "mock-1", title: "Test Card: The Movie", subtitle: "Mock", kind: "Movie", runtimeMin: 3, bitrateMbps: 0.5, playable: true, mode: "direct", reason: null, hasPoster: false },
  { id: "mock-2", title: "Test Card II: Colour Bars", subtitle: "Mock", kind: "Movie", runtimeMin: 3, bitrateMbps: 0.5, playable: true, mode: "direct", reason: null, hasPoster: false },
  {
    id: "mock-3",
    title: "Test Card III: Surround Sound",
    subtitle: "Mock",
    kind: "Movie",
    runtimeMin: 3,
    bitrateMbps: 6.1,
    playable: false,
    mode: null,
    reason: "The sound is AC3, which browsers cannot play without converting it.",
    hasPoster: false,
  },
];

// Stand-in subtitle tracks for the mock library and the browser tests.
export const MOCK_SUBTITLES = [
  { index: 0, lang: "eng", label: "English" },
  { index: 1, lang: "spa", label: "Spanish" },
];

export const MOCK_VTT = (lang: string) => `WEBVTT

00:00:00.000 --> 00:00:20.000
${lang === "spa" ? "Subtítulo de prueba" : "Test card subtitle"}

00:00:20.000 --> 00:00:60.000
${lang === "spa" ? "Segundo subtítulo" : "Second test subtitle"}
`.replace("00:00:60.000", "00:01:00.000");

export const MOCK_AUDIO = [
  { index: 0, lang: "eng", label: "English · AAC stereo", playable: true },
  { index: 1, lang: "spa", label: "Spanish · AAC stereo", playable: true },
];
