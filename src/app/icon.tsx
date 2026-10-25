import { ImageResponse } from "next/og";

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

// Two tickets as a line mark, #F5EFEB on #17222C.
export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", background: "#17222C", display: "flex" }}>
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none" stroke="#F5EFEB" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
          <g transform="rotate(-12 28 24)">
            <path d="M8 14h40v7a4 4 0 0 0 0 8v7H8v-7a4 4 0 0 0 0-8z" />
          </g>
          <g transform="rotate(8 36 40)">
            <path d="M16 30h40v7a4 4 0 0 0 0 8v7H16v-7a4 4 0 0 0 0-8z" fill="#17222C" />
            <path d="M40 33v3M40 40v3M40 47v3" />
          </g>
        </svg>
      </div>
    ),
    size,
  );
}
