# Devine B2B → WACRM Readiness: Developer Test Handoff

**Document purpose:** Give the testing developer one complete, executable description of the business intent, implemented WACRM changes, safety boundaries, setup procedure, test cases, expected results, and evidence required for sign-off.

**Prepared:** 31 August 2026
**Implementation location:** `wacrm/`
**Integration status:** WACRM is ready to receive structured Devine B2B lead records later. Devine and WACRM are **not connected** by this work.

---

## 1. Executive summary

Devine currently owns the B2B Meta → WhatsApp → Sales journey. The purpose of this WACRM work is to prepare a safe CRM destination for those leads without changing the live Devine journey or Meta webhook ownership.

After this work, an approved external system can make one authenticated API request to WACRM containing:

- A stable external lead ID
- Buyer contact details
- Existing WACRM tags
- Existing WACRM qualification custom fields
- High or normal sales intent
- Requested sales action
- Optional salesperson assignment

WACRM will create one contact and one deal, place the deal in the configured pipeline/stage, and clearly surface it to salespeople. Repeating the request returns the existing deal instead of creating duplicates or undoing human changes.

This implementation does **not** connect Devine, synchronize messages, create a WACRM conversation, send a WhatsApp message, or change Meta webhook configuration.

---

## 2. Business intent

The eventual customer journey remains:

```text
Meta Click-to-WhatsApp Ad
        ↓
Devine B2B WhatsApp
        ↓
Basic business qualification
        ↓
Brochure + dealer/distributor price list
        ↓
Buyer chooses a sales action
        ↓
Human salesperson takes over
        ↓
Products, quantities and commercial terms are discussed
        ↓
Order is closed
```

WACRM is being prepared for a later integration at the point where a qualified/high-intent buyer needs to become visible as a structured sales lead.

### The real problem this solves

Without this readiness layer, a future Devine integration would have to coordinate several unrelated WACRM operations and could create:

- Duplicate contacts when phone formats differ
- Duplicate deals when network requests are retried
- Leads in the wrong pipeline or stage
- Cross-account tag, field or salesperson references
- Hidden qualification data that salespeople cannot easily inspect
- Automation or WhatsApp side effects before message integration is approved
- A delayed retry that moves a deal backwards or replaces a human assignment

The implemented API gives the later connector one controlled, retry-safe entry point.

---

## 3. Scope boundaries

### Included

- Account-scoped external lead intake API
- API-key scope: `leads:write`
- Phone-based contact reuse and duplicate protection
- External lead/deal idempotency
- Existing tag assignment
- Existing custom-field qualification storage
- Configurable intake pipeline and initial stage
- Default or request-specific salesperson assignment
- High-intent, source, requested-action and qualification visibility
- Read-only discovery of valid tags, fields and salespeople
- Database constraints and RLS for intake settings
- Unit/route tests and public API documentation

### Explicitly excluded

- Devine → WACRM network connection
- Meta webhook forwarding or ownership changes
- WhatsApp conversation synchronization
- Creating a fake/empty WACRM conversation
- Replying to Devine conversations from WACRM
- Migrating existing Devine CRM data
- Modifying Devine during this WACRM readiness implementation
- Starter assortment recommendations
- Product selection logic
- Pricing, MOQ, margin, scheme or quotation logic
- Automatic order closure
- Any changes to a separate legacy/dedicated CRM unless separately approved

### Expected boundary after testing

```text
Devine repository                         WACRM repository
-----------------                         ----------------
Owns Meta webhook                         Owns its existing webhook only
Owns live B2B WhatsApp flow               Accepts structured lead records
Owns current buyer conversation           Stores contact + qualification + deal
Human replies remain in Devine CRM        Shows sales pipeline readiness

                 NO CONNECTION IN THIS PHASE
```

---

## 4. Repository roles

### `Devine/`

The main Devine commerce and WhatsApp application. Treat it as the owner of the current B2B customer journey and Meta webhook.

For this WACRM test:

- Do not add WACRM API calls.
- Do not change webhook routes or Meta configuration.
- Do not change the current WhatsApp handover behavior.
- Run its existing regression checks only if Devine is also being validated separately.

### `wacrm/`

The WACRM application containing the lead-readiness implementation described in this document.

All feature-specific setup, migration and tests below apply to WACRM.

---

## 5. What was implemented

### 5.1 Database migration

Migration:

```text
wacrm/supabase/migrations/040_external_lead_intake.sql
```

It adds the following fields to `deals`:

| Field              | Purpose                                               |
| ------------------ | ----------------------------------------------------- |
| `external_source`  | Stable lowercase source key such as `devine_b2b`      |
| `external_lead_id` | Stable lead identifier supplied by the source system  |
| `sales_intent`     | `normal` or `high`                                    |
| `requested_action` | Buyer’s requested next action, maximum 120 characters |

It adds:

- A unique index on `(account_id, external_source, external_lead_id)`
- An index for open deals by sales intent
- A new `lead_intake_settings` table
- Account-member read policies
- Admin-only insert/update/delete policies
- A validation trigger preventing cross-account pipeline, stage or assignee configuration

The migration is additive. Existing/manual deals keep `NULL` external identity fields and continue to work.

### 5.2 Lead intake configuration

WACRM administrators can configure:

- Target pipeline
- Initial stage
- Optional default salesperson
- Enabled/disabled state

Location:

```text
Settings → Deals & currency → External lead intake
```

Intake cannot be enabled without a valid pipeline and stage.

### 5.3 API authentication

New API-key scope:

```text
leads:write
```

The future Devine connector should receive only the minimum scopes it needs. This test requires `leads:write`.

WACRM stores only the API-key hash. The plaintext key is displayed once when created.

### 5.4 Lead options endpoint

```http
GET /api/v1/leads/options
Authorization: Bearer <WACRM_API_KEY>
Required scope: leads:write
```

Purpose:

- Confirm intake is enabled
- Return configured pipeline and initial stage
- Return valid WACRM tag IDs
- Return valid custom-field IDs
- Return assignable salesperson user IDs

An external connector must use these approved identifiers instead of reading the database directly.

### 5.5 Lead creation endpoint

```http
POST /api/v1/leads
Authorization: Bearer <WACRM_API_KEY>
Content-Type: application/json
Required scope: leads:write
```

The endpoint:

1. Authenticates the API key and fixes the account context.
2. Checks whether `(account, source, external ID)` already exists.
3. Returns the existing deal immediately on a retry.
4. Refuses intake when account configuration is missing or disabled.
5. Finds or creates the contact using normalized phone matching.
6. Updates only supplied contact details on first creation.
7. Validates every custom-field ID against the account.
8. Upserts only supplied qualification values.
9. Validates every tag ID against the account.
10. Adds tags without removing unrelated existing tags.
11. Resolves the default or requested salesperson within the account.
12. Creates the deal in the configured pipeline and stage.
13. Stores zero as the initial deal value because no commercial price is known yet.
14. Does not create a conversation or send a message.

### 5.6 Salesperson-facing UI

Pipeline deal cards now show:

- High-intent badge
- External source
- Requested action
- Existing contact and assignee information

Opening the deal shows:

- High-intent status
- External source
- External lead reference
- Requested action
- Non-empty qualification custom-field values
- Existing deal controls, notes, stage, status and assignment

### 5.7 Shared-tag correction

The Settings tag manager previously filtered tags using the user who created them. This could hide another administrator’s tags in the same account.

It now relies on WACRM’s account-scoped RLS and loads all tags visible to the account.

---

## 6. Files changed

### Database

- `wacrm/supabase/migrations/040_external_lead_intake.sql`

### API and validation

- `wacrm/src/lib/api/v1/leads.ts`
- `wacrm/src/app/api/v1/leads/route.ts`
- `wacrm/src/app/api/v1/leads/options/route.ts`
- `wacrm/src/lib/api-keys/scopes.ts`
- `wacrm/src/types/index.ts`

### UI

- `wacrm/src/components/settings/lead-intake-settings.tsx`
- `wacrm/src/components/settings/deals-settings.tsx`
- `wacrm/src/components/settings/tag-manager.tsx`
- `wacrm/src/components/pipelines/deal-card.tsx`
- `wacrm/src/components/pipelines/deal-form.tsx`
- `wacrm/messages/en.json`
- `wacrm/messages/ko.json`

### Tests and documentation

- `wacrm/src/lib/api/v1/leads.test.ts`
- `wacrm/src/app/api/v1/leads/route.test.ts`
- `wacrm/src/app/api/v1/leads/options/route.test.ts`
- `wacrm/docs/public-api.md`

---

## 7. Test environment requirements

Use a staging WACRM deployment and staging Supabase project first.

### Required access

- Updated `wacrm/` source
- Staging Supabase project
- Permission to apply migration 040
- Staging WACRM deployment access
- WACRM administrator login
- At least one non-viewer salesperson account
- One consenting real test phone number in E.164 format
- Node.js 20 or newer
- npm compatible with the lockfile

### Required WACRM environment variables

Use real staging values supplied securely. Do not commit them.

```dotenv
NEXT_PUBLIC_SUPABASE_URL=<staging-supabase-url>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<staging-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<staging-service-role-key>
ENCRYPTION_KEY=<staging-64-character-hex-key>
META_APP_SECRET=<existing-staging-meta-app-secret>
```

Retain all other environment variables already required by WACRM.

### Secret-handling rules

- Never commit `.env.local`.
- Never paste a production service-role key into a test report.
- Never include a complete WACRM API key in screenshots.
- Redact bearer tokens from terminal output.
- Do not use production Meta credentials for this isolated test.

---

## 8. Staging setup procedure

### Step 1: Install and verify the source

```bash
cd wacrm
npm ci
```

Expected result: dependency installation completes without changing application source files.

### Step 2: Apply database migrations

Apply all unapplied WACRM migrations in numeric order, including:

```text
040_external_lead_intake.sql
```

Verify:

- `deals` contains the four new fields.
- `idx_deals_external_identity` exists and is unique.
- `lead_intake_settings` exists.
- RLS is enabled on `lead_intake_settings`.
- The validation trigger exists.

Do not manually edit historical migrations.

### Step 3: Prepare CRM data through the UI

As a WACRM administrator:

1. Open **Pipelines**.
2. Create or select a B2B sales pipeline.
3. Confirm it has an initial lead stage.
4. Open **Settings → Fields & tags**.
5. Create the approved test qualification fields.
6. Create a source/high-intent test tag if the business wants tags in addition to deal badges.
7. Confirm the test salesperson is an owner, admin or agent—not a viewer.

Suggested qualification field names for staging only:

- Business Type
- State
- District
- City
- Purchase Capacity
- Requested Action

These are labels, not invented business values. Use only approved values in test requests.

### Step 4: Configure external intake

Open:

```text
Settings → Deals & currency → External lead intake
```

Select:

- The test B2B pipeline
- The initial lead stage
- A default salesperson, or leave it unassigned

Enable external lead intake and save.

Expected result: success notification and the configuration remains selected after reloading the page.

### Step 5: Create the test API key

Open:

```text
Settings → API keys → New API key
```

Use a descriptive name such as:

```text
Devine B2B staging test
```

Grant only:

```text
leads:write
```

Copy the key when it is displayed. Store it securely; WACRM will not display the full key again.

---

## 9. API test procedure

Set local shell placeholders without saving secrets into the repository:

```bash
export WACRM_BASE_URL="https://<staging-wacrm-domain>"
export WACRM_API_KEY="<one-time-staging-api-key>"
```

For Windows PowerShell:

```powershell
$env:WACRM_BASE_URL = "https://<staging-wacrm-domain>"
$env:WACRM_API_KEY = "<one-time-staging-api-key>"
```

### Test A: Discover valid options

```bash
curl "$WACRM_BASE_URL/api/v1/leads/options" \
  -H "Authorization: Bearer $WACRM_API_KEY"
```

PowerShell:

```powershell
curl.exe "$env:WACRM_BASE_URL/api/v1/leads/options" `
  -H "Authorization: Bearer $env:WACRM_API_KEY"
```

Expected response properties:

```json
{
  "data": {
    "enabled": true,
    "pipeline": { "id": "<uuid>", "name": "<configured pipeline>" },
    "initial_stage": { "id": "<uuid>", "name": "<configured stage>" },
    "default_salesperson_user_id": "<uuid-or-null>",
    "tags": [],
    "custom_fields": [],
    "salespeople": []
  }
}
```

Record the required tag and custom-field IDs for the next test. Do not query Supabase directly for them.

### Test B: Create a high-intent lead

Use a consenting real test number in full E.164 format. Replace every placeholder with an ID from the options response.

```bash
curl -X POST "$WACRM_BASE_URL/api/v1/leads" \
  -H "Authorization: Bearer $WACRM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "devine_b2b",
    "external_id": "developer-real-phone-test-001",
    "title": "Devine B2B staging enquiry",
    "contact": {
      "phone": "+91XXXXXXXXXX",
      "name": "Test Buyer",
      "email": "test-buyer@example.com",
      "company": "Test Business"
    },
    "sales_intent": "high",
    "requested_action": "Discuss order",
    "tag_ids": ["<valid-tag-uuid>"],
    "custom_fields": {
      "<business-type-field-uuid>": "Distributor",
      "<state-field-uuid>": "Approved test state"
    }
  }'
```

Expected result:

- HTTP `201`
- `data.created` is `true`
- Response contains `contact_id`
- Response contains one deal ID
- Deal source is `devine_b2b`
- Deal external ID matches the request
- Deal intent is `high`
- Deal requested action matches the request

### Test C: Retry the identical request

Run the exact same request again.

Expected result:

- HTTP `200`
- `data.created` is `false`
- Same contact ID
- Same deal ID
- No second deal
- No second contact

### Test D: Protect human sales work from retries

1. Open the deal in WACRM.
2. Move it to a later stage.
3. Assign it to a different salesperson.
4. Add a salesperson note.
5. Repeat the original API request.

Expected result:

- HTTP `200`
- Same deal ID
- Human-selected stage remains unchanged
- Human-selected assignee remains unchanged
- Deal status remains unchanged
- Salesperson note remains unchanged
- Qualification fields are not overwritten by the retry

### Test E: Phone normalization

Create a new external lead ID using the same real phone with harmless formatting differences supported by the application.

Expected result:

- Existing contact is reused
- A new deal may be created because the external lead ID is different
- No duplicate contact is created

Do not use a different person’s phone to simulate formatting.

---

## 10. UI verification checklist

### Settings

- [ ] External lead intake card appears under Deals & currency.
- [ ] Pipeline selector lists account pipelines.
- [ ] Stage selector shows stages only from the selected pipeline.
- [ ] Default salesperson excludes viewer-only members.
- [ ] Intake cannot be enabled without pipeline and stage.
- [ ] Non-admin users cannot edit settings.
- [ ] Saved settings survive reload.

### Tags

- [ ] Tags created by one account administrator appear for another administrator.
- [ ] Tags from another account never appear.

### Contact

- [ ] One contact exists for the tested phone.
- [ ] Name, email and company match the request.
- [ ] Supplied tags are present.
- [ ] Unrelated pre-existing tags are preserved.
- [ ] Supplied qualification custom fields show correct values.

### Pipeline card

- [ ] Deal appears in the configured pipeline and initial stage.
- [ ] High-intent badge is visible.
- [ ] Source is visible.
- [ ] Requested action is visible.
- [ ] Default or requested salesperson is visible when assigned.

### Deal detail

- [ ] External source is visible.
- [ ] External lead reference is visible.
- [ ] Requested action is visible.
- [ ] Qualification values are visible.
- [ ] Existing deal editing, stage, status and assignment controls still work.

### WhatsApp boundary

- [ ] No WACRM conversation is created by lead intake.
- [ ] No Inbox thread appears solely because of this API request.
- [ ] The real test phone receives no WhatsApp message.
- [ ] No template message is sent.
- [ ] No tag-triggered automation starts.
- [ ] Existing Meta webhook settings remain unchanged.
- [ ] Devine receives no requests from WACRM.

The absence of a phone message and WACRM conversation is a required success condition for this phase.

---

## 11. Negative and security tests

### Authentication

| Test                            | Expected result  |
| ------------------------------- | ---------------- |
| No Authorization header         | HTTP `401`       |
| Malformed key                   | HTTP `401`       |
| Revoked key                     | HTTP `401`       |
| Expired key                     | HTTP `401`       |
| Valid key without `leads:write` | HTTP `403`       |
| Valid `leads:write` key         | Request proceeds |

### Intake configuration

| Test                              | Expected result                          |
| --------------------------------- | ---------------------------------------- |
| Intake disabled                   | HTTP `409`, `lead_intake_not_configured` |
| Pipeline missing/deleted          | HTTP `409`                               |
| Stage missing/deleted             | HTTP `409`                               |
| Stage does not belong to pipeline | Configuration rejected or intake blocked |

### Payload validation

| Test                              | Expected result                      |
| --------------------------------- | ------------------------------------ |
| Missing source                    | HTTP `400`                           |
| Source contains spaces            | HTTP `400`                           |
| Source contains uppercase letters | Accepted and normalized to lowercase |
| Missing external ID               | HTTP `400`                           |
| Missing title                     | HTTP `400`                           |
| Missing contact phone             | HTTP `400`                           |
| Invalid/non-E.164 phone           | HTTP `400`                           |
| Invalid intent                    | HTTP `400`                           |
| More than 30 tags                 | HTTP `400`                           |
| More than 50 custom fields        | HTTP `400`                           |
| Overlong requested action         | HTTP `400`                           |

### Account isolation

Use two staging WACRM accounts if available.

| Test                                       | Expected result                          |
| ------------------------------------------ | ---------------------------------------- |
| Tag ID from another account                | HTTP `400`                               |
| Custom-field ID from another account       | HTTP `400`                               |
| Salesperson user ID from another account   | HTTP `400`                               |
| Viewer assigned as salesperson             | HTTP `400`                               |
| Same source/external ID in another account | Allowed as a separate account-owned deal |
| Account A options request                  | Never exposes Account B metadata         |

### Duplicate and concurrency protection

- [ ] Ten identical sequential requests produce one deal.
- [ ] Concurrent identical requests produce one deal.
- [ ] Same phone with multiple external IDs produces one contact and multiple intentional deals.
- [ ] Different accounts may use the same source/external ID independently.

---

## 12. Regression checks

The implementation must not break existing WACRM functionality.

At minimum, smoke-test:

- [ ] Login and account loading
- [ ] Contacts list, search and edit
- [ ] CSV contact import if available in staging
- [ ] Tag creation and assignment
- [ ] Custom-field creation and editing
- [ ] Pipeline creation and stage movement
- [ ] Manual deal creation/editing/deletion
- [ ] Deal assignment
- [ ] Inbox loading
- [ ] Existing human conversation assignment
- [ ] Existing API key creation/revocation
- [ ] Existing contacts API
- [ ] Existing conversations read API
- [ ] Existing WhatsApp configuration page loads without modification

Do not send a live WhatsApp message merely to test this readiness feature.

---

## 13. Automated verification commands

Run from `wacrm/`:

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run build
```

### Results recorded during implementation

- Full test suite: 81 test files passed, 833 tests passed.
- Final lead-focused suite: 3 test files passed, 9 tests passed.
- TypeScript: passed.
- Changed-file lint: passed with zero warnings/errors.
- Repository lint: zero errors; 37 unrelated pre-existing warnings.
- Next.js production build: passed with the new routes:
  - `/api/v1/leads`
  - `/api/v1/leads/options`

The local build required temporary placeholder Supabase variables because the source archive did not include `.env.local`. The developer must build using valid staging environment values.

---

## 14. Success criteria

Testing is successful only when all of the following are true:

1. Migration 040 applies cleanly to staging.
2. An administrator can configure and enable external lead intake.
3. A `leads:write` key can discover valid intake options.
4. A valid external lead request creates exactly one contact and one deal.
5. The deal enters the configured pipeline and initial stage.
6. High sales intent, source and requested action are clearly visible.
7. Qualification fields are visible to the salesperson.
8. The configured/default salesperson is assigned correctly.
9. Repeating the same request returns the same deal.
10. A retry does not overwrite stage, status, assignment, notes or qualification edits.
11. Phone normalization prevents duplicate contacts.
12. Cross-account tag, field and salesperson references are rejected.
13. Revoked, expired or insufficiently scoped API keys are rejected.
14. Existing WACRM features continue working.
15. No WhatsApp message or WACRM conversation is created.
16. Meta webhook ownership remains unchanged.
17. Devine remains unconnected and unmodified by this test.
18. Automated tests, typecheck and production build pass.

Any failure in items 1–17 blocks production deployment of this readiness layer.

---

## 15. Known limitation and future phase

This work prepares lead records, not live conversations.

Until a separate Devine↔WACRM integration is explicitly approved and implemented:

- The original buyer conversation remains in Devine.
- A WACRM salesperson cannot reply inside that Devine conversation.
- WACRM should not claim Devine’s Meta webhook.
- WACRM lead intake must not be described as end-to-end WhatsApp handover.

The future integration will need a separately reviewed design for:

- Message synchronization or reply routing
- Conversation identity mapping
- Human handover state
- Automation suppression across systems
- Delivery/status reconciliation
- Webhook ownership and failure recovery

Do not implement these as part of testing this document.

---

## 16. Required developer evidence

Return a test report containing:

### Environment

- Staging application URL
- Migration version applied
- Commit/ZIP version tested
- Node/npm versions
- Browser used for UI checks

### Automated checks

- Output summary from `npm test`
- Output from `npm run typecheck`
- Output summary from `npm run lint`
- Output summary from `npm run build`

### API evidence

- Redacted `GET /api/v1/leads/options` response
- Redacted first lead response showing HTTP `201`
- Redacted retry response showing HTTP `200`
- Confirmation that both responses contain the same deal ID
- Negative-test response samples

### UI evidence

- Screenshot of enabled intake settings
- Screenshot of the contact with qualification/tags
- Screenshot of the high-intent pipeline card
- Screenshot of deal detail with source, reference, action and qualification
- Screenshot showing salesperson assignment

### Safety evidence

- Confirmation that the test phone received no message
- Confirmation that no WACRM conversation was created
- Confirmation that Devine was not connected
- Confirmation that Meta webhook settings were not changed
- Confirmation that no production secret appears in the report

---

## 17. Developer sign-off template

Copy this section into the returned report:

```markdown
# WACRM External Lead Readiness Test Report

## Result

- [ ] PASS
- [ ] FAIL
- [ ] PASS WITH CONCERNS

## Version tested

- Source version:
- Migration applied:
- Staging URL:
- Test date:
- Tester:

## Automated checks

| Check             | Result | Notes |
| ----------------- | ------ | ----- |
| npm test          |        |       |
| npm run typecheck |        |       |
| npm run lint      |        |       |
| npm run build     |        |       |

## Functional checks

| Check                         | Result | Evidence |
| ----------------------------- | ------ | -------- |
| Intake configuration          |        |          |
| Options discovery             |        |          |
| First lead creates 201        |        |          |
| Retry returns 200/same deal   |        |          |
| One normalized contact        |        |          |
| Qualification visible         |        |          |
| Intent/source/action visible  |        |          |
| Salesperson assigned          |        |          |
| Human edits survive retry     |        |          |
| Account isolation             |        |          |
| Invalid/revoked keys rejected |        |          |
| No conversation created       |        |          |
| No WhatsApp message sent      |        |          |
| Meta webhook unchanged        |        |          |
| Devine remains unconnected    |        |          |

## Defects

For every defect include:

1. Severity
2. Exact reproduction steps
3. Expected result
4. Actual result
5. Request/response with secrets redacted
6. Screenshot or log
7. Whether existing functionality is affected

## Final recommendation

- [ ] Ready to deploy WACRM readiness changes
- [ ] Fix defects and retest
- [ ] Requires business/security decision

Tester signature/name:
Date:
```

---

## 18. Production gate

Do not deploy to production until:

- Staging migration succeeds.
- All success criteria pass.
- The developer submits the required evidence.
- Production environment variables are verified separately.
- A database backup/recovery point exists.
- An administrator has selected the intended production pipeline/stage.
- The production API key is created with minimum scope and stored securely.
- The team understands that Devine is still not connected.

Production deployment of this readiness layer does not authorize the future Devine integration.
