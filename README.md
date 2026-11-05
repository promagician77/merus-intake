# GoHighLevel → MerusCase intake bridge (working sample)

This bridge is one-way. When a GoHighLevel opportunity reaches **Signed**, it creates a case in MerusCase with the lead's contact and injury details.

What it does:
- Checks MerusCase for an existing contact first.
- Sends one injury per POST.
- Maps firm-specific IDs (case status, venue, office, attorney and staff users).
- Gives each of the three fields with no API field a home.
- Never creates a second case, injury, party or note, even when a MerusCase reply is lost.

What's needed:
- Node 22.13+ with the built-in `node:sqlite`.
- No other dependencies.
- One SQLite file.

## How a lead flows

1. **GoHighLevel workflow.**
   - Trigger: *Pipeline Stage Changed*, filtered to pipeline Intake and stage Signed.
   - Action: *Custom Webhook*, POST to `/hooks/ghl/signed`, authorization *Bearer token*.
   - Raw JSON body: `ghl/custom-webhook-body.json`. Its custom-field keys must match the template, e.g. `injury_1_date`.
   - The plain *Webhook* action also works; put the token in `?key=`.
2. **Bridge receives the lead.**
   - It answers 202 in a few milliseconds and stores the lead under an idempotency key.
   - The key is the opportunity ID, or the contact ID plus the signed date.
   - A repeat delivery returns the first result.
   - A lead at any other stage is ignored with a 200.
3. **Checks** (`src/validate.js`). These hold the lead before any write:
   - missing name, DOB, phone or email, injury type, or date;
   - a CT injury with no end date, or ending before it starts;
   - future dates;
   - an unknown body part;
   - more than 10 body parts or more than 3 injuries;
   - a duplicate injury;
   - an unmapped attorney.

   A held lead gets the GoHighLevel tag `merus-needs-review` and a note with the reasons. Once fixed in GoHighLevel and sent again, it replaces the stored copy and runs.
4. **Dedupe** (`src/dedupe.js`). This matches against a local index of MerusCase contacts. Each lead is either **link**, **review** or **new**; the rules are below.
5. **Plan and run** (`src/plan.js`, `src/executor.js`). Every write is journalled:
   1. `caseFiles/add`: case + contact (or `CaseFile.contact_id` for an existing client) + injury 1.
   2. `contacts/edit`: existing client only. It fills fields that are blank in MerusCase and never overwrites. Differences go into a case note.
   3. `injuries/edit` with no Injury ID ("add a new injury", per the published docs): injuries 2..n.
   4. Employer: reuse an indexed company contact or `contacts/add`, then `parties/add`.
   5. `activities/add`: referral source; "Retainer signed" dated on the signed date; data notes.
   6. GoHighLevel: tag `merus-case-created` + note with the MerusCase case ID.

## The three fields with no API field

| Field | Where it lands | Why |
|---|---|---|
| Employer | `contacts/add` (company) → `parties/add` | The employer is a party on the case. Company names are deduped after normalising, so "North Bay Builders, Inc." = "NORTH BAY BUILDERS INC". |
| Referral source | `activities/add`, firm type "Intake: referral source" | It's searchable and filterable in the case activity log. Create the type once with `npm run check-config -- --create`. |
| Signed date | `activities/add` "Retainer signed", `data[Activity][date]` = signed date | It sits on the case timeline on the day the client signed. Also set `date_opened` if `caseFiles/add` accepts it. |

## Dedupe without a contact search

MerusCase's published API reads a contact only by ID (`contacts/view/:id`), and the firm's endpoint list has no search. The bridge therefore keeps an index.

**Build and refresh**
- Full build: `npm run index -- --full`. It walks `caseFiles/index` → `parties/view` per case → `contacts/view` per contact.
- At 3,000 cases this took 6,016 calls on the stand-in, about 50 minutes at 2 requests a second. MerusCase publishes no rate limit; set `MERUS_MIN_INTERVAL_MS`.
- Nightly: `npm run index` reads only cases with `modified[gte]` since the last run.
- Contacts the bridge creates are indexed at once.

**Rules, strictest first**
- **Link** when any of these agree:
  - DOB + first + last name, allowing for English and Spanish nicknames, accents, hyphens, Jr./Sr. and swapped first and last names;
  - DOB + phone or email + one name;
  - both names + phone or email, when MerusCase has no DOB on file.
- **Review** when:
  - a phone or email is shared with a different DOB (relatives);
  - only the name matches;
  - several contacts match.
- **New** when the name is the same but the DOB differs and nothing else is shared.

**Resolving a review**

```
POST /intakes/:id/resolve
Authorization: Bearer $ADMIN_TOKEN

{"decision":"link","contactId":123}
or
{"decision":"new"}
```

## Lost replies and crashes

MerusCase takes no idempotency key. Before a write is sent its step is marked `sent`. If the reply is lost, or the process dies, the bridge reads the record back before sending again:

| Write | Read-back |
|---|---|
| `caseFiles/add` | `caseFiles/index?modified[gte]=` (looking back a day) → `injuries/view` + `parties/view` |
| `injuries/edit` | `injuries/view` |
| `parties/add` | `parties/view` |
| `activities/add` | `activities/index`; every note carries a marker `[intake <key> <what>]` |

Known limit: `contacts/add` for an employer can't be read back without a contact search. A lost reply there can leave one unattached duplicate employer contact, and the step note says so.

A refused step (4xx) stops the intake with the step named. After the fix, `POST /intakes/:id/retry` resumes from that step.

## Configuration

- `config/mapping.csv`: the 29-field map, in the same layout as the firm's spreadsheet. Export the real one as CSV.
- `config/firm.json`: firm-specific IDs.
  - Users, case type and activity types are verified with `npm run check-config` (users/index, caseTypes/index, activityTypes/index).
  - Case status, office, venues and body-part IDs have no published list endpoint. Fill them from the spreadsheet.
- `config/bodyparts.json`: body-part words → MerusCase IDs, with left/right/bilateral read from the text (`q1_injury_description_N_id` / `_lr`).
- Environment:
  - `MERUS_TOKEN`: OAuth bearer token.
  - `MERUS_BASE_URL`: defaults to `https://api.meruscase.com`.
  - `GHL_TOKEN`: Private Integration token with contacts scope; rotate it every 90 days.
  - `WEBHOOK_TOKEN`, `ADMIN_TOKEN`, `DB_PATH`, `PORT`.

**To confirm against the firm's spreadsheet.** The field names and response envelope of `caseFiles/add`, `contacts/add` and `contacts/edit` aren't in the public docs. Until they're confirmed:
- `src/merus/client.js` reads IDs defensively;
- `fake/merus.js` marks the shapes it assumes.

## Run

```bash
npm test          # 47 tests against a stand-in MerusCase and GoHighLevel
npm test > results/tests.tap; npm run bench; npm run build   # page numbers
npm start         # the service
```

## What was measured, and how

- **Dedupe:** 3,000 synthetic clients indexed through the indexer, then 300 leads with known answers. Result: 0 wrong links; 118/120 returning clients linked, 2 sent to review; 149/150 new people created; 30 lookalikes, 0 linked.
- **Test day:** 50 deliveries (40 leads, 10 sent twice) with 14 injected MerusCase failures.
  - Results: 33 cases (5 for existing clients), 45 injuries, 10 lost replies read back, 0 duplicates.
  - Webhook acknowledged in a median of 3 ms.
- **Synthetic and stand-in:**
  - Every person, case and ID is synthetic.
  - The MerusCase stand-in follows the published endpoints and parameters.
  - Firm IDs are placeholders.

## Sources

- MerusCase developer guide: [endpoints](https://docs.meruscase.com/guides/developers-guide/endpoints.html), [app setup and authentication](https://docs.meruscase.com/guides/developers-guide/authentication.html).
- HighLevel:
  - [Custom Webhook action](https://help.gohighlevel.com/support/solutions/articles/155000003305-workflow-action-custom-webhook)
  - [Webhook (Outbound) action](https://gohighlevelassist.freshdesk.com/support/solutions/articles/155000003299-workflow-action-webhook-outbound-)
  - [Private Integration tokens](https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken.md)

Deploy the page: import this folder into Vercel. `vercel.json` serves `site/` with `X-Robots-Tag: noindex, nofollow`.
