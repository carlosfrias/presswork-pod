// Use console.warn for internal notifier logs to avoid a dependency on getSettings().
// notifySlack / notifyEmail must never throw — they absorb all errors internally.

export async function notifySlack(
  message: string,
  opts?: { severity?: "info" | "warn" | "error" }
): Promise<void> {
  const url = process.env["SLACK_WEBHOOK_URL"];
  if (!url) {
    console.warn("[notifier] SLACK_WEBHOOK_URL not set — skipping Slack alert");
    return;
  }
  try {
    const severity = opts?.severity ?? "info";
    const icon =
      severity === "error" ? ":red_circle:" : severity === "warn" ? ":warning:" : ":white_circle:";
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `${icon} ${message}` }),
    });
    if (!res.ok) {
      console.warn(`[notifier] Slack POST returned ${res.status}`);
    }
  } catch (err) {
    console.warn("[notifier] Slack POST failed:", String(err));
  }
}

export async function notifyEmail(subject: string, body: string): Promise<void> {
  const apiKey = process.env["RESEND_API_KEY"];
  const to = process.env["ALERT_EMAIL"];
  if (!apiKey || !to) {
    console.warn("[notifier] RESEND_API_KEY or ALERT_EMAIL not set — skipping email alert");
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: "presswork@presswork.app",
        to,
        subject,
        text: body,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.warn(`[notifier] Resend POST returned ${res.status}: ${errBody}`);
    }
  } catch (err) {
    console.warn("[notifier] Resend POST failed:", String(err));
  }
}
