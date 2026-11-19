# Mesina Farms CRM — Fresh Installation


## New CRM account approval and identity management

New CRM agents are provisioned only when they sign in through ZITADEL, and their initial status is **Inactive**. A CRM Admin must open **Agents & Access Control** and select **Activate** before the user can sign in. Inactive ZITADEL users receive an approval-pending message and cannot obtain a CRM session. Admins can assign an existing CRM role from the role selector in the Agents table. Manual Add Agent, Edit Agent, and password-reset controls are not available. Username and email are managed in ZITADEL and synchronized on the user's next sign-in; the CRM profile only edits CRM contact details. Existing account statuses are preserved during the upgrade.

Complete Mesina Farms CRM application for Ubuntu Server using Docker Compose and PostgreSQL 16.

**Current release: 2.08.9**

## Release 2.08.3 — ZITADEL redirect-loop fix

The CRM now verifies and restores the server-side HttpOnly session before initiating another ZITADEL redirect. It rehydrates the current CRM profile from `/api/auth/bootstrap` on page load, preventing a temporary empty/stale browser profile from triggering an authentication loop. The callback marker is removed only after the server confirms the session.

After deploying, confirm that `CRM_PUBLIC_URL`, `ZITADEL_REDIRECT_URI`, and the ZITADEL application's allowed Redirect URI all use the exact same public CRM hostname and HTTPS URL. Do not mix `crm.mesina.farm` with another CRM hostname.

## Requirements

- Ubuntu Server 22.04 or 24.04 LTS
- Docker Engine and Docker Compose plugin
- At least 2 CPU cores, 2 GB RAM, and 20 GB available storage

## Installation

1. Copy the complete project folder to the server.
2. Create the environment file:

   ```bash
   cp .env.example .env
   nano .env
   chmod 600 .env
   ```

3. Set unique values for `POSTGRES_PASSWORD`, `JWT_SECRET`, and `ADMIN_INITIAL_PASSWORD`. The administrator password must be at least 12 characters.
4. Start the application:

   ```bash
   docker compose up -d --build
   ```

5. Check service status:

   ```bash
   docker compose ps
   docker compose logs -f crm_app
   ```

The first database initialization automatically executes the single schema file at `scripts/postgresql_crm.sql`. The initial administrator username is `admin`; its password is the value configured in `ADMIN_INITIAL_PASSWORD`.


## ZITADEL authentication (v2.08)

The CRM uses the self-hosted ZITADEL instance as its identity provider. Staff authenticate at `https://auth.mesina.farm`; CRM business data and role permissions remain in the CRM PostgreSQL database.

### Create the ZITADEL application

1. In the ZITADEL Console, create a dedicated project named `Mesina Farms CRM`; do not reuse ZITADEL's built-in default project.
2. Add a project role such as `crm_staff` and assign it to each person who is allowed to enter the CRM.
3. In the dedicated project settings, enable **Check Role Assignment on Authentication**. This makes ZITADEL reject users who have not been explicitly assigned a project role, preventing arbitrary instance users from self-provisioning CRM accounts.
4. Create a **Web application** in that project using **Authorization Code with PKCE** and a confidential client authentication method.
5. Add this exact Redirect URI: `https://crm.mesina.farm/api/auth/callback/zitadel`
6. Add this exact Post Logout URI: `https://crm.mesina.farm`
7. Enable the `openid`, `profile`, and `email` scopes. The CRM requires a verified email claim.
8. Copy the Client ID and Client Secret into the CRM server's `.env`. Never put the client secret in frontend/Vite variables or commit it to source control.
9. Ensure the ZITADEL issuer/discovery URL is `https://auth.mesina.farm` and reachable from the CRM application server over HTTPS.

### Configure the CRM

Set these values in `.env`:

```dotenv
ZITADEL_ISSUER=https://auth.mesina.farm
ZITADEL_CLIENT_ID=your_zitadel_client_id
ZITADEL_CLIENT_SECRET=your_zitadel_client_secret
CRM_PUBLIC_URL=https://crm.mesina.farm
ZITADEL_REDIRECT_URI=https://crm.mesina.farm/api/auth/callback/zitadel
ZITADEL_POST_LOGOUT_URI=https://crm.mesina.farm
ZITADEL_DEFAULT_CRM_ROLE=Sales Agent
ZITADEL_BOOTSTRAP_ADMIN_EMAIL=the_verified_email_of_your_existing_admin
```

`ZITADEL_BOOTSTRAP_ADMIN_EMAIL` is an optional one-time first-login link for the seeded CRM Admin account. Set it to the verified email of the ZITADEL user who should own the existing Admin record. The first matching verified ZITADEL login claims the unlinked seeded Admin record. Protect this setting carefully; remove it from `.env` after the administrator has successfully signed in and the `zitadel_user_id` column is populated.

For new ZITADEL identities, the CRM creates a staff record on first successful login and assigns `ZITADEL_DEFAULT_CRM_ROLE` (default `Sales Agent`). The configured role must exist and cannot be `Admin` or `Manager`. Existing staff records can be linked by an exact, verified email match; their existing CRM role is preserved. A ZITADEL identity already linked to another account cannot be reused.

ZITADEL manages passwords, usernames, and identity email addresses; the CRM synchronizes username and email from verified ZITADEL claims at sign-in. Do not enable unrestricted self-registration in ZITADEL unless you intentionally want unapproved users to be able to create ZITADEL identities; the CRM project role assignment check is the access gate. The CRM continues to manage staff contact fields, active/inactive status, CRM roles, table permissions, and operational data. Username and email are read-only in the CRM profile. The CRM session is carried in a `Secure`, `HttpOnly`, `SameSite=Lax` cookie; the browser stores only the non-secret user profile, not the session token. Password changes for linked users must be made in ZITADEL. Deactivating a staff record in the CRM blocks subsequent CRM sign-ins even if the ZITADEL identity remains active. Disabling a ZITADEL identity prevents new sign-ins; an already-issued CRM session can remain active until its 12-hour expiry unless the CRM staff record is also deactivated or its CRM session is revoked.

### Apply and verify

The server applies additive migrations automatically at startup (`agents.zitadel_user_id` and `crm_sessions.id_token`); no database volume reset or data deletion is required.

```bash
chmod 600 .env
docker compose up -d --build
docker compose logs -f crm_app
```

Then verify:

- `https://auth.mesina.farm/.well-known/openid-configuration` is reachable from the CRM server.
- The ZITADEL application contains the exact redirect and post-logout URIs above.
- The CRM login page shows **Continue with ZITADEL**.
- The first administrator login is linked to the existing Admin record.
- A newly created ordinary ZITADEL user is provisioned with the default non-privileged CRM role.
- An inactive CRM staff record cannot sign in.

The old CRM username/password login endpoint is disabled. Existing local-password sessions may remain valid until their 12-hour expiry; ask existing users to sign out after rollout. Do not delete the PostgreSQL volume.

## Database

- `scripts/postgresql_crm.sql` is the only SQL file included for database initialization.
- It defines the complete schema for a new, empty PostgreSQL database.
- Docker executes it automatically when the PostgreSQL data volume is created for the first time.
- The application stores its core CRM state in `crm_state.state` (JSONB). Expense, attendance, authentication, and other dedicated server-side modules use their respective relational tables.
- Do not edit the database directly while the application is running.

**Fresh installation only:** this package initializes a new database. It is not an in-place database upgrade package. Never run the fresh-install SQL against a populated database.

To deliberately erase the existing Compose database and initialize a clean one, first make and verify a backup, then run:

```bash
docker compose down -v
docker compose up -d --build
```

`docker compose down -v` permanently deletes all data in the Compose PostgreSQL volume.

## Data exports and invoice printing

- Table export controls provide CSV, PDF, and XLSX downloads, plus JSON, TSV, and XML. Choose the format from the dropdown and use the adjacent download-icon button.
- Exports include the complete filtered result set, including rows on other pagination pages.
- Export access is controlled per table by the role's table access and Export Data permissions. Administrators have export access by default; all non-admin roles start with export disabled until an administrator enables individual tables.
- Operations Overview sections can be granted or restricted independently by role.
- Export permission checkboxes appear inline on each table row in Manage Access Restriction. Operations Overview visibility controls remain unchanged.
- The invoice Print action opens the system print dialog. Select a locally connected or network printer configured on the computer running the browser.

## Roles and access

- **Admin** has full access and manages roles, table access, and export permissions.
- **Manager** can manage permitted ordinary agent accounts but cannot access Admin or Manager accounts or assign those roles.
- Other roles can access only the pages and tables granted by Admin.
- Access rules are enforced by the application API as well as the interface.

## Backups and restore

Use the included scripts:

```bash
./scripts/backup.sh
CONFIRM_RESTORE=YES ./scripts/restore.sh ./backups/your_backup.sql
```

The restore script requires explicit confirmation and creates a pre-restore backup before applying the selected dump.

## Operations

```bash
docker compose ps
docker compose restart crm_app
docker compose logs -f crm_app
```

The application is available on the port configured by `APP_PORT` in `.env` (default `3000`).


## Version 2.07 release notes

- Create Order and Edit Order now accept a discount percentage (0–100%). The CRM calculates the discount amount from the subtotal and displays the final discounted total.
- Orders retain the calculated discount amount in PHP and also save the percentage in `discount_percent`, keeping invoice totals and historical discount amounts consistent.
- The Revenues icon now uses the Philippine peso symbol.
- The single fresh-install PostgreSQL schema includes the `discount_percent` field. Existing v2.05 databases receive the new column safely at application startup.

## Version 2.04 update notes

- Replaced separate export format buttons with a format dropdown and compact download icon.
- Added JSON, TSV, and XML export formats alongside CSV, PDF, and XLSX.
- Added per-role visibility settings for Operations Overview sections.
- Moved each table's export permission checkbox into its corresponding Manage Access Restriction row; removed the separate Raw Data Export Permissions section.
- The existing `scripts/postgresql_crm.sql` remains the complete fresh-install schema; no manual SQL migration is required for a new installation.


## JSON backup restore behavior

- JSON restore is an authenticated Admin-only workflow.
- The browser validates the backup, submits the restored state to `PUT /api/state`, and waits for the PostgreSQL API response before showing success.
- The API applies the normal server-side validations and writes the restored application state to `crm_state.state` (JSONB), with an audit event. Existing agent password hashes are retained when imported account records do not contain a password hash.
- A failed API/database write is reported as a failed restore; the UI does not report success merely because browser state changed.
- The JSON backup format covers the CRM application-state collections stored in `crm_state.state` and the agent records mirrored to `agents`. Dedicated expense, attendance, session, login-throttle, and audit-event tables are outside this JSON snapshot. For a complete PostgreSQL database image, use the SQL backup/restore scripts above; they use `pg_dump`/`psql` and include the dedicated relational tables.


## SQL backup, restore, and PostgreSQL visibility (v2.07)

The Admin > Database Backup & Restore controls now export and import `.sql` backups. The exported SQL is executable in pgAdmin 4 Query Tool against the CRM database; the WebUI importer accepts the same CRM-generated SQL file. Legacy JSON backups are still accepted by the WebUI for backward compatibility.

The application currently uses `crm_state.state` (JSONB) as its authoritative persisted application document. To make individual records easy to inspect in pgAdmin 4, v2.07 also maintains `crm_state_records`, with one row per collection record and its original object in the `data` JSONB column. Query it with, for example:

```sql
SELECT record_key, data
FROM crm_state_records
WHERE table_name = 'orders'
ORDER BY record_key;
```

This mirror is deliberately separate from the older normalized operational tables in the schema; those legacy tables are not the application's write path. The actual CRM data is persisted in `crm_state` and mirrored to `crm_state_records` transactionally. Do not expect inserts to appear in legacy tables such as `orders` until a dedicated normalized-schema migration is performed.

## Version 2.07 security update

- Truncate operational data is disabled until an Admin completes an SQL backup export. The application confirms the browser download with the server, and the server independently checks and consumes that confirmation inside the truncate transaction.
- A confirmed export is single-use for truncation; after a successful truncate, another SQL export is required.
- Removed the PostgreSQL badge from the top-left brand area and updated release labels to 2.07.
- Added `crm_backup_exports` to the single fresh-install SQL schema.

### Public IP address in Histories

The Histories `ip_address` value is captured by the server when a history row is first saved. If the CRM is published behind Nginx, Traefik, Cloudflare, or another reverse proxy, configure that trusted edge to forward the visitor's real client IP and set `TRUST_PROXY=1` in `.env`. The server checks `CF-Connecting-IP`, `True-Client-IP`, `X-Real-IP`, and Express' trusted `req.ip` in that order. The reverse proxy must overwrite these headers with the address it observed; do not enable proxy trust when clients can connect directly and spoof forwarded headers. For direct connections, keep `TRUST_PROXY=0`; the server records the peer address visible to the application. Restart the CRM container after changing this setting.

If a deployment's proxy does not forward the visitor address, the application cannot infer the visitor's public IP from a private Docker or proxy address; the proxy configuration must be corrected.
