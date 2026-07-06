#!/usr/bin/env python3
"""Build and deploy the ber-intake stack, injecting secrets from files.

Portable — no hard-coded home paths, no samconfig dependency. Secrets are read
from the website's secrets dir (override with BER_SECRETS_DIR).

Secrets (API keys, tokens, OAuth client secret / refresh token, etc.) are NOT
passed as CloudFormation parameters — they are written to SSM Parameter Store as
SecureStrings under /ber-intake/<ENV_NAME> and loaded at runtime by
shared/secrets.ts. Only non-secret config is passed as stack parameters. A
secret absent from its file is skipped (its existing SSM value is left as-is),
so a partial secrets dir never wipes a live secret. Prints only NAMES, never
values.

Env toggles (with test-friendly defaults):
  STACK_NAME           default "ber-intake"
  AWS_REGION           default "us-east-1"
  PUBLIC_SITE_URL      default the CloudFront test site; set to
                       https://cannygreen.com for production
  QUOTE_FROM_EMAIL     default anish@cannygreen.com
  TEST_EMAIL_OVERRIDE  default "off" (send to real recipients)
  QB_ENV               optional: sandbox | production
  QB_TAX_CODE_ID       optional: QuickBooks TaxCode id for the BER survey line
                       (standard/23%); blank leaves the stack value
  QB_OUTLAY_TAX_CODE_ID optional: TaxCode id for the SEAI publishing-fee outlay
                       line (0% / No VAT); blank leaves the stack value
  SIGNWELL_TEST_MODE   optional: true | false (false = real signatures/billing)
  BER_SECRETS_DIR      override the secrets directory
  SKIP_BUILD=1         skip `sam build`

Only params whose env var is set are overridden; anything unset keeps the
stack's current value, so a normal run never regresses a production toggle.
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
SSM_PREFIX = os.environ.get("SECRETS_PREFIX", "/ber-intake/")

params: dict[str, str] = {}      # non-secret CloudFormation parameter overrides
secrets: dict[str, str] = {}     # ENV_NAME -> value, written to SSM SecureStrings


def read_kv(filename: str, keys: dict[str, str], target: dict[str, str]) -> None:
    """Read KEY=VALUE lines from SECRETS/filename into `target` (keys: file->dest)."""
    path = SECRETS / filename
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            for file_key, dest in keys.items():
                if line.startswith(file_key + "=") or line.startswith(file_key + " "):
                    target[dest] = line.split("=", 1)[1].strip().strip('"').strip("'")
    except FileNotFoundError:
        print(f"WARN: {filename} not found — related values left unchanged")


# --- config toggles (non-secret params) ---
params["QuoteFromEmail"] = os.environ.get("QUOTE_FROM_EMAIL", "anish@cannygreen.com")
params["QuoteFromName"] = os.environ.get("QUOTE_FROM_NAME", "Anish Raghavan")
params["TestEmailOverride"] = os.environ.get("TEST_EMAIL_OVERRIDE", "off")
params["PublicSiteUrl"] = os.environ.get(
    "PUBLIC_SITE_URL", "https://d1ze07dqk0doqs.cloudfront.net"
)
if os.environ.get("QB_ENV"):
    params["QbEnv"] = os.environ["QB_ENV"]
if os.environ.get("QB_TAX_CODE_ID"):
    params["QbTaxCodeId"] = os.environ["QB_TAX_CODE_ID"]
if os.environ.get("QB_OUTLAY_TAX_CODE_ID"):
    params["QbOutlayTaxCodeId"] = os.environ["QB_OUTLAY_TAX_CODE_ID"]
if os.environ.get("QB_TAX_RATE"):
    params["QbTaxRate"] = os.environ["QB_TAX_RATE"]
if os.environ.get("SIGNWELL_TEST_MODE"):
    params["SignWellTestMode"] = os.environ["SIGNWELL_TEST_MODE"]

# --- non-secret config from files (stack parameters) ---
read_kv(".env", {"GOOGLE_CALENDAR_ID": "GoogleCalendarId"}, params)
read_kv("quickbooks.env", {"QB_CLIENT_ID": "QbClientId"}, params)
read_kv("signwell.env", {"SIGNWELL_TEMPLATE_ID": "SignWellTemplateId"}, params)

# --- secrets from files (SSM SecureStrings, keyed by their runtime env name) ---
read_kv(".env", {"REACT_APP_GOOGLE_MAPS_API_KEY": "GOOGLE_MAPS_API_KEY"}, secrets)
read_kv("quickbooks.env", {"QB_CLIENT_SECRET": "QB_CLIENT_SECRET"}, secrets)
read_kv("signwell.env", {"SIGNWELL_API_KEY": "SIGNWELL_API_KEY",
                         "SIGNWELL_WEBHOOK_TOKEN": "SIGNWELL_WEBHOOK_TOKEN"}, secrets)
read_kv("turnstile.env", {"TURNSTILE_SECRET": "TURNSTILE_SECRET"}, secrets)
# Shared key the BER_APP tablet sends as x-surveyor-key (cloud sync + bug-report
# upload). Blank/absent => /surveyor/* endpoints reject all requests.
read_kv("surveyor.env", {"SURVEYOR_ACCESS_KEY": "SURVEYOR_ACCESS_KEY"}, secrets)
# ALLOWED_CHAT_ID is not a secret (it's an id) — passed as a stack parameter.
read_kv("telegram.env", {"ALLOWED_CHAT_ID": "AllowedChatId"}, params)
read_kv("telegram.env", {"TELEGRAM_BOT_TOKEN": "TELEGRAM_BOT_TOKEN",
                         "TELEGRAM_WEBHOOK_SECRET": "TELEGRAM_WEBHOOK_SECRET",
                         "PARTNER_ACCESS_KEY": "PARTNER_ACCESS_KEY"}, secrets)

# Google OAuth (calendar): client id is a non-secret param; client secret and
# refresh token are secrets.
try:
    creds = json.loads((SECRETS / "credentials.json").read_text())["web"]
    params["GoogleClientId"] = creds["client_id"]
    secrets["GOOGLE_CLIENT_SECRET"] = creds["client_secret"]
    tok = json.loads((SECRETS / "token.json").read_text())
    if tok.get("refresh_token"):
        secrets["GOOGLE_REFRESH_TOKEN"] = tok["refresh_token"]
    else:
        print("WARN: no refresh_token in token.json — calendar won't work")
except Exception as e:
    print("WARN: could not load Google Calendar creds:", e)

# --- push secrets to SSM Parameter Store (SecureStrings) ---
# Only non-empty values are written, so a missing/blank secret never wipes the
# live one. deploy.py must run with credentials allowed to ssm:PutParameter.
for name, value in secrets.items():
    if not value:
        print(f"skip SSM {name} (blank) — leaving existing value")
        continue
    ssm_name = SSM_PREFIX + name
    res = subprocess.run(
        ["aws", "ssm", "put-parameter",
         "--name", ssm_name, "--type", "SecureString",
         "--value", value, "--overwrite", "--region", REGION],
        capture_output=True, text=True,
    )
    if res.returncode != 0:
        sys.exit(f"failed to write SSM {ssm_name}: {res.stderr.strip()}")
    print(f"wrote SSM {ssm_name}")

print("Deploying", STACK_NAME, "with parameters:", sorted(params.keys()))
print("Secrets in SSM under", SSM_PREFIX + ":", sorted(secrets.keys()))

# --- build + deploy ---
if not os.environ.get("SKIP_BUILD"):
    if subprocess.run(["sam", "build"], cwd=ROOT).returncode != 0:
        sys.exit("sam build failed")

# Quote the value so SAM keeps multi-word values (e.g. "Anish Raghavan") intact
# instead of splitting them on spaces.
overrides = [f'ParameterKey={k},ParameterValue="{v}"' for k, v in params.items()]
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
