#!/usr/bin/env node
// One-off Google Calendar OAuth tool — mints/refreshes the calendar token the
// intake Lambda uses (via GOOGLE_REFRESH_TOKEN in SSM). Run it when there is no
// token yet, or when the refresh token has expired/been revoked (symptom: the
// booking calendar's slot listing / event booking starts failing).
//
// It reuses the SAME Google OAuth "web" client + `secrets/` files the old
// website server did — only that dead server is gone, so this is the standalone
// replacement. Dependency-free: Node's http + global fetch (Node ≥ 18), no
// googleapis SDK (matching shared/calendar.ts's raw-REST approach).
//
// Usage:
//   node scripts/google-calendar-auth.js
// then open the printed URL, approve, and it writes secrets/token.json. Finally
// re-run scripts/deploy.py so the new refresh token is pushed to SSM.
//
// The OAuth redirect URI registered for this client is
// http://localhost:5000/auth/callback, so this listens on port 5000 — don't
// change the port without also updating the client's redirect URIs in the
// Google Cloud console.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const SECRETS = process.env.BER_SECRETS_DIR || path.join(__dirname, "..", "secrets");
const CRED_PATH = path.join(SECRETS, "credentials.json");
const TOKEN_PATH = path.join(SECRETS, "token.json");

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

function loadClient() {
  if (!fs.existsSync(CRED_PATH)) {
    console.error(`No credentials at ${CRED_PATH} — this needs the OAuth "web" client JSON.`);
    process.exit(1);
  }
  const web = JSON.parse(fs.readFileSync(CRED_PATH, "utf8")).web;
  const redirectUri = web.redirect_uris[0];
  return { web, redirectUri, redirect: new URL(redirectUri) };
}

function authUrl(web, redirectUri) {
  const p = new URLSearchParams({
    client_id: web.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force a fresh refresh token every time
    include_granted_scopes: "true",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

async function exchangeCode(web, redirectUri, code) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: web.client_id,
      client_secret: web.client_secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`token exchange failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data; // { access_token, expires_in, refresh_token, scope, token_type }
}

function saveToken(tokens) {
  // Preserve an existing refresh_token if Google omits one (it shouldn't, with
  // prompt=consent — belt and braces). token.json shape matches what deploy.py
  // reads (it only needs `refresh_token`).
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  } catch {
    /* first run — no prior token */
  }
  const out = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || prev.refresh_token,
    scope: tokens.scope,
    token_type: tokens.token_type,
    expiry_date: Date.now() + (tokens.expires_in || 0) * 1000,
  };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(out));
  return out;
}

function main() {
  const { web, redirectUri, redirect } = loadClient();
  const port = Number(redirect.port) || 80;
  const url = authUrl(web, redirectUri);

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://localhost:${port}`);
    if (reqUrl.pathname !== redirect.pathname) {
      res.writeHead(404).end("Not found");
      return;
    }
    const code = reqUrl.searchParams.get("code");
    if (!code) {
      res.writeHead(400).end("Missing ?code");
      return;
    }
    try {
      const tokens = await exchangeCode(web, redirectUri, code);
      const saved = saveToken(tokens);
      res.writeHead(200).end("Authentication successful — you can close this window.");
      console.log(`\n✓ Wrote ${TOKEN_PATH}`);
      console.log(`  refresh_token present: ${!!saved.refresh_token}`);
      console.log(`\nNext: re-run scripts/deploy.py to push GOOGLE_REFRESH_TOKEN to SSM.`);
    } catch (err) {
      res.writeHead(500).end(`Authentication failed: ${err.message}`);
      console.error(err);
    } finally {
      server.close();
    }
  });

  server.listen(port, () => {
    console.log(`Listening on ${redirectUri} for the OAuth redirect.`);
    console.log(`\nOpen this URL in a browser, sign in as the calendar owner, and approve:\n\n${url}\n`);
  });
}

main();
