// Cloudflare Turnstile (CAPTCHA) verification for the public website
// job-creation path. Fails closed: if TURNSTILE_SECRET is unset the request is
// rejected (use Cloudflare's test secret for local dev). Hostname is restricted
// on the sitekey in the Cloudflare dashboard.

export async function verifyTurnstile(
  token: string | undefined,
  remoteIp?: string,
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) {
    // Fail closed: no secret means we can't verify, so reject rather than let
    // job creation run wide open. (For local dev use Cloudflare's test secret.)
    console.error("TURNSTILE_SECRET not set — rejecting job creation");
    return false;
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
