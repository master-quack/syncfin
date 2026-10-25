"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "./Button";

export function PasscodeForm() {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ passcode: value }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) return router.refresh();
    const body = await res?.json().catch(() => null);
    setError(body?.error ?? "Could not reach the server.");
  };

  return (
    <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-3">
      <label htmlFor="passcode" className="text-small text-muted">
        Passcode
      </label>
      <input
        id="passcode"
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoComplete="current-password"
        className="rounded border border-line bg-surface px-4 py-3 text-body text-text"
      />
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !value}>
        {busy ? "Checking" : "Let me in"}
      </Button>
    </form>
  );
}
