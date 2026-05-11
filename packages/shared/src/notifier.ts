import pino from "pino";

// Notifier uses a local pino instance instead of the project getLogger() to
// avoid pulling getSettings() into this module — notifySlack/notifyEmail can be
// invoked from error paths where settings might not yet be valid. Level is read
// directly from process.env so we don't need the validated config.
const log = pino({
  name: "notifier",
  level: process.env["LOG_LEVEL"] ?? "info",
});

// notifySlack / notifyEmail must never throw — they absorb all errors internally.

export async function notifySlack(
  message: string,
  opts?: { severity?: "info" | "warn" | "error" }
): Promise<void> {
  const url = process.env["SLACK_WEBHOOK_URL"];
  if (!url) {
    log.warn({ action: "slack_skip", reason: "missing_url" }, "SLACK_WEBHOOK_URL not set — skipping Slack alert");
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
      log.warn({ action: "slack_post_non_ok", status: res.status }, "Slack POST returned non-2xx");
    }
  } catch (err) {
    log.warn({ action: "slack_post_failed", err: String(err) }, "Slack POST failed");
  }
}

export async function notifyEmail(subject: string, body: string): Promise<void> {
  const apiKey = process.env["RESEND_API_KEY"];
  const to = process.env["ALERT_EMAIL"];
  if (!apiKey || !to) {
    log.warn(
      { action: "email_skip", reason: "missing_credentials" },
      "RESEND_API_KEY or ALERT_EMAIL not set — skipping email alert"
    );
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
      log.warn(
        { action: "resend_post_non_ok", status: res.status, body: errBody },
        "Resend POST returned non-2xx"
      );
    }
  } catch (err) {
    log.warn({ action: "resend_post_failed", err: String(err) }, "Resend POST failed");
  }
}
