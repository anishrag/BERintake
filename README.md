# BER Intake

Client intake backend — the precursor to **BER_APP** (`../BER_APP`). It turns a
lead into a confirmed, paid, signed job and hands BER_APP a partial `Ber`
record to start the on-site survey from.

AWS serverless: API Gateway (HTTP API) + Lambda + DynamoDB, deployed with SAM.

## Job funnel

```
created ─┐
         ├─ pending_review ─(owner approves on Telegram)─┐
         └──────────────────────────────────────────────┴─ quote_sent
   → quoted → booked → paid → signed → confirmed → pulled (into BER_APP)
```

A job is created through one of two front doors, both hitting the same
`createJob` core:

- **Telegram bot** (you): one of the five wizards below → job goes straight to
  `quote_sent` (or `prebooked` when you set the slot yourself).
- **Partner web form** (e.g. the solar contractor, no Telegram): `POST /jobs`
  with the shared access key → job lands in `pending_review` and pings you on
  Telegram with **Send / Discard** buttons. Approving releases the quote link.

Every job records its `source` (`telegram` / `partner:<name>`) for referral
tracking.

### Telegram intake pipelines

| Command | You provide | Client does online | Slot | Invoice |
| --- | --- | --- | --- | --- |
| `/newquote` | name, email, phone, eircode | picks property type, sees zone price, books | client picks | client pays (zone price), due on the day |
| `/newclient` | + size, date/time, optional price | fills details, signs LoE (`prebooked` → `booked`) | you set it | client pays (agreed or zone price), due on the day |
| `/newsolar` | name*, email, phone*, eircode | picks property type + slot, details, LoE | client picks | solar partner billed (solar.env zone×size table, ex VAT, −€100 while the 15-invoice discount lasts); client never sees a price |
| `/newsolar_arranged` | + date/time | picks property type, details, LoE | you set it | same as `/newsolar`, sent once the form is complete |
| `/newauctioneera` | email + price paid (name/phone/eircode*) | picks property type + slot, details, LoE | client picks | client already paid Auctioneera: invoice = paid price − 15% commission (of the ex-VAT fee, commission carries VAT); shown to the client, nothing due |

\* skippable — the client's form backfills the record. Solar/Auctioneera jobs
carry `billTo` on the Job record; partner config + the solar price/discount
tables live in `secrets/solar.env`. The Auctioneera commission rate is a
constant in `src/shared/qbInvoice.ts`. `/cancel` aborts a running wizard;
anything the bot doesn't recognise gets the command list back.

## Layout

```
template.yaml            SAM: DynamoDB tables + 3 Lambdas behind an HTTP API
src/shared/types.ts      the Job + BerSeed contract (canonical home)
src/shared/jobs.ts       createJob core, lookups, status transitions
src/shared/botState.ts   Telegram /newclient wizard state (TTL'd in DynamoDB)
src/shared/telegram.ts   Bot API wrapper
src/handlers/createJob.ts        POST /jobs            (partner form / web admin)
src/handlers/getJob.ts           GET  /jobs/{token}    (client form hydration)
src/handlers/telegramWebhook.ts  POST /telegram/webhook
```

## Endpoints (so far)

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST | `/jobs` | partner form | create a job (access-key gated) |
| GET | `/jobs/{token}` | client form | read client-safe job state |
| POST | `/telegram/webhook` | Telegram | bot wizard + approve/discard |

Still to come: quote save, booking, Revolut payment + webhook, e-signature +
webhook, `berSeed` assembly, and the assessor pull endpoint (`GET /assessor/jobs`)
that BER_APP syncs from.

## Develop

```bash
npm install
npm run typecheck     # tsc --noEmit
```

## Deploy

```bash
npm install            # esbuild must be present for `sam build`
sam build
sam deploy --guided    # first time; prompts for the parameters below
```

Parameters (`sam deploy` will ask, or set in `samconfig.toml`):

- `TelegramBotToken` — from @BotFather
- `PartnerAccessKey` — a long random string the partner form must send
- `PublicSiteUrl` — defaults to `https://cannygreen.ie`
- `AllowedChatId` — **leave blank on the first deploy**

### Lock the bot to you

1. After the first deploy, register the webhook (URL is in the stack outputs):
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<TelegramWebhookUrl>"
   ```
2. Message the bot `/start`. It replies with your chat id.
3. Redeploy with that id:
   ```bash
   sam deploy --parameter-overrides AllowedChatId=<your-id>
   ```

Now only you can drive the bot, and partner submissions notify you.

> Secrets are passed as SAM parameters for now. Move `TelegramBotToken` /
> `PartnerAccessKey` to SSM Parameter Store / Secrets Manager before this
> handles real client data.

## Deploying

Backend deploy is a single portable script that injects secrets and runs
`sam build` + `sam deploy` (stack `ber-intake`, us-east-1):

    python3 scripts/deploy.py

Secrets are read from `../BERwebsite/server/secrets/` (override with
`BER_SECRETS_DIR`):

| file | keys |
| --- | --- |
| `.env` | `REACT_APP_GOOGLE_MAPS_API_KEY`, `GOOGLE_CALENDAR_ID` |
| `credentials.json`, `token.json` | Google OAuth (calendar) |
| `quickbooks.env` | `QB_CLIENT_ID`, `QB_CLIENT_SECRET` |
| `signwell.env` | `SIGNWELL_API_KEY`, `SIGNWELL_TEMPLATE_ID` |
| `turnstile.env` | `TURNSTILE_SECRET` |
| `telegram.env` *(optional, for a from-scratch deploy)* | `TELEGRAM_BOT_TOKEN`, `PARTNER_ACCESS_KEY`, `ALLOWED_CHAT_ID` |

Env toggles: `PUBLIC_SITE_URL` (prod: `https://cannygreen.com`),
`TEST_EMAIL_OVERRIDE` (`off` for real recipients), `QUOTE_FROM_EMAIL`,
`QB_ENV` (`sandbox`|`production`), `STACK_NAME`, `AWS_REGION`, `SKIP_BUILD`.

NoEcho params not found in a secrets file keep their previous CloudFormation
value — fine for the existing stack; provide `telegram.env` to stand up a
fresh one.

## New-machine setup

1. Install: **Node 22**, **AWS CLI v2**, **AWS SAM CLI**, **Python 3** (GDAL/ogr2ogr only if regenerating zone maps).
2. `git clone` this repo and **BERwebsite** as siblings under one parent dir.
3. `npm install` here and in `BERwebsite/client`.
4. Configure **AWS credentials** (region `us-east-1`). The infrastructure already lives in AWS — you only manage it; no full redeploy needed.
5. Copy the **secrets** into `BERwebsite/server/secrets/` (never in git — transfer securely).
6. Deploy backend: `python3 scripts/deploy.py`. The site (Turnstile site key is a committed default in `client/src/config/api.js`) builds with the client's normal build; sync `client/build` to the S3/CloudFront hosting and invalidate.
