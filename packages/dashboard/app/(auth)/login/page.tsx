"use client";

import { useState } from "react";
import { browserClient } from "@/lib/supabase/browser";
import { Button } from "@/components/ui/Button";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setErrMsg(null);
    try {
      const supabase = browserClient();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
      setState("sent");
    } catch (e) {
      setState("error");
      setErrMsg(e instanceof Error ? e.message : "Failed to send magic link");
    }
  }

  return (
    <div className="mx-auto mt-24 max-w-sm rounded-(--radius-lg) border border-(--surface-line) bg-(--surface-1) p-8">
      <h1 className="font-display text-2xl font-semibold text-(--text-primary)">
        Presswork
      </h1>
      <p className="mt-2 text-sm text-(--text-muted)">
        Owner sign-in. Magic link will arrive in your inbox.
      </p>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
        <label className="flex flex-col gap-2 text-xs text-(--text-muted) uppercase tracking-wider">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-10 rounded-(--radius-sm) border border-(--surface-line) bg-(--surface-2) px-3 text-sm text-(--text-primary) focus:outline-none focus-visible:border-(--accent-warm)"
            disabled={state === "sending" || state === "sent"}
            autoComplete="email"
          />
        </label>
        <Button
          type="submit"
          variant="primary"
          disabled={state === "sending" || state === "sent"}
        >
          {state === "sending" ? "Sending..." : state === "sent" ? "Sent" : "Send magic link"}
        </Button>
        {state === "sent" && (
          <p className="text-xs text-(--accent-good)">
            Check your inbox. The link signs you in for 1 hour.
          </p>
        )}
        {state === "error" && (
          <p className="text-xs text-(--accent-bad)">{errMsg}</p>
        )}
      </form>
    </div>
  );
}
