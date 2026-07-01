// Cloudflare Turnstile (CAPTCHA) verification for the public website
// job-creation path. If TURNSTILE_SECRET is unset, verification is skipped
// (dev only) and a warning is logged — set it in production.

export async function verifyTurnstile(
  token: string | undefined,
  remoteIp?: string,
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) {
    console.warn("TURNSTILE_SECRET not set — skipping CAPTCHA check (dev only)");
    return true;
  }
  if (!token) return false;

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.append("remoteip", remoteIp);

  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
    );
    const data: any = await res.json();
    return data.success === true;
  } catch (err) {
    console.error("turnstile verify error", err);
    return false;
  }
}
