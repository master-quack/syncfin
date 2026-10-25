import type { ButtonHTMLAttributes } from "react";

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" }) {
  const look =
    variant === "primary"
      ? "bg-text text-bg hover:bg-muted"
      : "border border-line text-text hover:bg-raised";
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded px-5 py-3 text-body font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${look} ${className}`}
    />
  );
}
