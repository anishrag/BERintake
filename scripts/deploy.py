#!/usr/bin/env python3
"""Build and deploy the ber-intake stack, injecting secrets from files.

Portable — no hard-coded home paths, no samconfig dependency. Secrets are read
from the website's secrets dir (override with BER_SECRETS_DIR). NoEcho params
not found in a secrets file are left to CloudFormation's previous value (fine
for the existing stack; for a from-scratch deploy, provide them via
telegram.env). Prints only parameter NAMES, never values.

Env toggles (with test-friendly defaults):
  STACK_NAME           default "ber-intake"
  AWS_REGION           default "us-east-1"
  PUBLIC_SITE_URL      default the CloudFront test site; set to
                       https://cannygreen.com for production
  QUOTE_FROM_EMAIL     default anish@cannygreen.com
  TEST_EMAIL_OVERRIDE  default "off" (send to real recipients)
  QB_ENV               optional: sandbox | production
  BER_SECRETS_DIR      override the secrets directory
  SKIP_BUILD=1         skip `sam build`
"""
import json
import os
import subprocess
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent          # ber_intake/
SECRETS = pathlib.Path(
    os.environ.get("BER_SECRETS_DIR")
    or ROOT.parent / "BERwebsite" / "server" / "secrets"
)

STACK_NAME = os.environ.get("STACK_NAME", "ber-intake")
REGION = os.environ.get("AWS_REGION", "us-east-1")

params: dict[str, str] = {}


def read_kv(filename: str, keys: dict[str, str]) -> None:
    """Read KEY=VALUE lines from SECRETS/filename into params (keys: file->Param)."""
    path = SECRETS / filename
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            for file_key, param in keys.items():
                if line.startswith(file_key + "=") or line.startswith(file_key + " "):
                    params[param] = line.split("=", 1)[1].strip().strip('"').strip("'")
    except FileNotFoundError:
        print(f"WARN: {filename} not found — related params left to previous value")


# --- config toggles ---
params["QuoteFromEmail"] = os.environ.get("QUOTE_FROM_EMAIL", "anish@cannygreen.com")
params["TestEmailOverride"] = os.environ.get("TEST_EMAIL_OVERRIDE", "off")
params["PublicSiteUrl"] = os.environ.get(
    "PUBLIC_SITE_URL", "https://d1ze07dqk0doqs.cloudfront.net"
)
if os.environ.get("QB_ENV"):
    params["QbEnv"] = os.environ["QB_ENV"]

# --- secrets from files ---
read_kv(".env", {"REACT_APP_GOOGLE_MAPS_API_KEY": "GoogleMapsApiKey",
                 "GOOGLE_CALENDAR_ID": "GoogleCalendarId"})
read_kv("quickbooks.env", {"QB_CLIENT_ID": "QbClientId",
                           "QB_CLIENT_SECRET": "QbClientSecret"})
read_kv("signwell.env", {"SIGNWELL_API_KEY": "SignWellApiKey",
                         "SIGNWELL_TEMPLATE_ID": "SignWellTemplateId",
                         "SIGNWELL_WEBHOOK_TOKEN": "SignWellWebhookToken"})
read_kv("turnstile.env", {"TURNSTILE_SECRET": "TurnstileSecret"})
# Optional — Telegram bot secrets for a from-scratch deploy.
read_kv("telegram.env", {"TELEGRAM_BOT_TOKEN": "TelegramBotToken",
                         "TELEGRAM_WEBHOOK_SECRET": "TelegramWebhookSecret",
                         "PARTNER_ACCESS_KEY": "PartnerAccessKey",
                         "ALLOWED_CHAT_ID": "AllowedChatId"})

# Google OAuth (calendar) from credentials.json + token.json
try:
    creds = json.loads((SECRETS / "credentials.json").read_text())["web"]
    params["GoogleClientId"] = creds["client_id"]
    params["GoogleClientSecret"] = creds["client_secret"]
    tok = json.loads((SECRETS / "token.json").read_text())
    if tok.get("refresh_token"):
        params["GoogleRefreshToken"] = tok["refresh_token"]
    else:
        print("WARN: no refresh_token in token.json — calendar won't work")
except Exception as e:
    print("WARN: could not load Google Calendar creds:", e)

print("Deploying", STACK_NAME, "with parameters:", sorted(params.keys()))

# --- build + deploy ---
if not os.environ.get("SKIP_BUILD"):
    if subprocess.run(["sam", "build"], cwd=ROOT).returncode != 0:
        sys.exit("sam build failed")

overrides = [f"ParameterKey={k},ParameterValue={v}" for k, v in params.items()]
cmd = [
    "sam", "deploy",
    "--stack-name", STACK_NAME,
    "--region", REGION,
    "--resolve-s3",
    "--capabilities", "CAPABILITY_IAM", "CAPABILITY_AUTO_EXPAND",
    "--no-confirm-changeset", "--no-fail-on-empty-changeset",
    "--parameter-overrides", *overrides,
]
sys.exit(subprocess.run(cmd, cwd=ROOT).returncode)
