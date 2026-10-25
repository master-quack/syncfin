import type { Config } from "tailwindcss";

// Tokens from DESIGN-SYSTEM.md section 9. Type sizes are the strict set 64/40/28/18/14.
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    fontSize: {
      d1: ["64px", { lineHeight: "1" }],
      d2: ["40px", { lineHeight: "1.05" }],
      d3: ["28px", { lineHeight: "1.1" }],
      body: ["18px", { lineHeight: "1.5" }],
      small: ["14px", { lineHeight: "1.45" }],
    },
    colors: {
      transparent: "transparent",
      current: "currentColor",
      bg: "#17222C",
      surface: "#2F4156",
      raised: "#3B5268",
      text: "#F5EFEB",
      muted: "#9FB3C0",
      accent: "#C8D9E6",
      dim: "#7D93A3",
      line: "#567C8D",
      danger: "#E88A85",
    },
    boxShadow: { none: "none" },
    borderRadius: { none: "0", sm: "4px", DEFAULT: "6px", full: "9999px" },
    extend: {
      fontFamily: {
        display: ["var(--font-bebas)", "Impact", "sans-serif"],
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
