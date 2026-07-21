# BER Checklist — Gmail Add-on

A Google Workspace Add-on (Apps Script) that shows a BER job's outstanding
follow-up checklist when you open the client's email in Gmail, and lets you tick
items off. Renders on Gmail web, Android, and iOS from one deployment.

## How it works

- On opening a message it reads the **Reply-To** (the client's address; the
  visible `From` is the `forwards@cannygreen.com` forwarder) plus the
  subject/body, and calls `GET /jobs/lookup` on the BERintake API.
- The backend matches that email against jobs in `details_requested`
  (name/address in the body disambiguate) and returns the checklist.
- Ticking items → `POST /jobs/{jobId}/checklist`. When the last item is ticked
  the job advances to `details_provided`.

The checklist itself is seeded when you press **Send email** on the tablet's
Follow-ups tab — the ticked requests become the checklist, all unticked.

## Files

- `appsscript.json` — the Workspace Add-on manifest (contextual Gmail trigger,
  `script.external_request` + Gmail read-only scopes).
- `Code.gs` — the CardService logic.

## One-time deploy

You need Node + [`clasp`](https://github.com/google/clasp) (`npm i -g @google/clasp`).

> Commands below are for **clasp 3.x** (`clasp --version`). `clasp create` and
> `clasp open` were renamed (`create-script`/`open-script`); the short aliases
> `create`/`push`/`pull` still work.

1. **Log in:** `clasp login`
2. **Create the script project** (from this folder):
   ```
   cd gmail-addon
   clasp create-script --type standalone --title "BER Checklist"
   ```
   This writes a `.clasp.json` (holds the new `scriptId`) — gitignored, keep it local.
   ⚠️ **`create` overwrites `appsscript.json` with a bare default** (no add-on
   config). Restore this repo's `appsscript.json` (it has the `addOns` block +
   scopes) before pushing — `git checkout appsscript.json`.
3. **Push the code:** `clasp push -f` (uploads `Code.gs` + the restored manifest)
4. **Set the secret:** open the IDE (`clasp open-script`), then
   **Project Settings ▸ Script Properties ▸ Add script property**:
   - `ADDON_KEY` = the value of `ADDON_ACCESS_KEY` from `BERintake/secrets/addon.env`
   - *(optional)* `API_BASE` = override the API URL (defaults to the prod HTTP API).
5. **Associate a standard GCP project** (Project Settings ▸ Google Cloud Platform
   project) — required to install a Workspace Add-on. Any GCP project you own works.
6. **Deploy → Test deployments ▸ Install** (or **Deploy ▸ New deployment ▸
   Add-on**). Choose "Install" to load it into your own Gmail.
7. Open a client email in Gmail — the **BER Checklist** card appears in the right
   rail (web) or the add-on tray (mobile).

### No-terminal alternative

Skip clasp: go to <https://script.google.com>, **New project**, paste `Code.gs`
into the editor, then **Project Settings ▸ Show "appsscript.json"** and paste the
manifest over it. Then follow steps 4–6 above.

## Auth

The add-on authenticates to the API with a shared secret (`x-addon-key`) stored
in Script Properties — never in the code. It's a separate key from the tablet's
surveyor key. Rotate by updating `BERintake/secrets/addon.env`, redeploying the
backend (`python scripts/deploy.py`), and updating the `ADDON_KEY` script property.

## Notes / limits (v1)

- Only jobs in `details_requested` / `details_provided` are matched; closed jobs
  never surface.
- Auto-detecting attachments ("cert attached → auto-tick") is out of scope (a
  future inbound-SES pipeline). Ticking is manual here.
- Matching is by client email first, then name/address hints — inconsistent
  addressing means the fuzzy fallback can miss; the email match is the reliable path.
