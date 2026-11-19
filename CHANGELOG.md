## 2.08.10
- Fix server-side IP capture for newly created history records.
- Add IP Address column to Histories and PostgreSQL schema.
- Preserve existing history IP values and add trusted reverse-proxy configuration.

# Changelog

## 2.08.9
- Expose Admin and Manager role assignments only to users currently authenticated as Admin.
- Allow Managers to assign ordinary roles only; enforce privileged-role restrictions on the server.
- Protect existing Admin and Manager accounts from Manager-side role changes.

v2.08.9 — ZITADEL-managed identity and role list cleanup

- Locked username and email fields in My Profile; identity fields are synchronized from verified ZITADEL claims at sign-in.
- Removed manual Add Agent, Edit Agent, and password-reset controls from Agents & Access Control.
- New agent records can only be provisioned by ZITADEL; browser state synchronization cannot create accounts.
- Preserved Admin-only role assignment and account activation/deactivation controls.
- Made the PostgreSQL roles master table authoritative for role selectors and stopped startup reconciliation from resurrecting deleted roles.
- Pruned stale role-permission keys when the current role list is refreshed.

## v2.08.7 — Synchronize CRM role dropdowns with PostgreSQL

- Adds an authenticated `/api/roles` endpoint that reads the normalized PostgreSQL `roles` master table.
- Makes the Agents role filter and create/edit role selectors use the synchronized role list, not only hard-coded defaults.
- Makes the role administration selector and Roles listing include roles already present in PostgreSQL.
- Keeps Admin and Manager roles hidden from non-Admin role selectors; Managers can assign only ordinary roles.
- Newly created roles appear immediately, and database-managed role changes are refreshed periodically.
- Preserves role permissions in `crm_state.rolePermissions`; no database reset or migration is required.

## v2.08.6 — Admin approval for new CRM accounts

- New ZITADEL-provisioned users are created as Inactive and cannot establish a CRM session until an Admin activates them.
- New manually created agent accounts default to Inactive.
- Only Admins can change agent account status; Manager edits preserve the existing status.
- PostgreSQL default for new agent rows is Inactive; existing account statuses are preserved.

# Changelog

## v2.08.5 - ZITADEL profile picture

- Reads the standard `picture` claim from the verified ZITADEL UserInfo response.
- Uses the HTTPS ZITADEL profile image as the CRM avatar when no custom CRM avatar is already saved.
- Syncs the identity-provider avatar to the agent profile and PostgreSQL-backed CRM state.
- Keeps custom uploaded avatars supported and validates remote ZITADEL avatar URLs before retaining them.


## v2.08.4 - Logout flow fix

- Prevents the automatic ZITADEL sign-in redirect from firing while logout is in progress.
- Uses the OIDC logout state parameter to return to a signed-out login screen.
- Clears local CRM profile data and keeps the browser on the signed-out screen if the logout endpoint cannot return an identity-provider logout URL.


## v2.08.2 - Direct ZITADEL sign-in

- Removed the intermediate CRM login screen and automatically redirects unauthenticated visitors to the server-side ZITADEL authorization endpoint.
- Preserves the ZITADEL callback bootstrap so successful sign-ins are not redirected back into a new authorization request.
- Shows a small retry link only when the identity-provider callback returns an authentication error.


## Version 2.08
- Replaced the local username/password login screen with self-hosted ZITADEL OIDC authentication using Authorization Code with PKCE.
- Added server-side OIDC discovery, state/nonce validation, PKCE verification, ID-token signature and claim validation, and UserInfo subject verification.
- Added secure HttpOnly CRM session cookies and ZITADEL logout; CRM session tokens are no longer stored in browser localStorage for ZITADEL users.
- Added automatic staff provisioning and verified-email linking, with a restricted default CRM role and no automatic Admin/Manager assignment.
- Added additive startup migrations for ZITADEL identity mapping and ID-token-backed logout; existing CRM data is preserved.
- Preserved CRM roles, table permissions, profile management, and operational data in PostgreSQL.


## Version 2.07

- Disabled Truncate operational data by default; Admin must export CRM SQL data and the browser must confirm the download before the button becomes available.
- Enforced the backup-before-truncate requirement on the server with a single-use export confirmation consumed transactionally during truncation.
- Added `crm_backup_exports` to the single fresh-install SQL schema and runtime initialization for existing installations.
- Removed the PostgreSQL badge from the top-left CRM brand area and updated visible version labels and metadata to 2.07.

## Version 2.06

- Changed Create Order and Edit Order discounts to percentages from 0% to 100%; the CRM calculates the PHP discount amount from the subtotal and saves the discounted total.
- Added `discount_percent` to orders while retaining `discount` as the calculated PHP amount for invoice snapshots and backward compatibility with existing order records.
- Replaced the Revenues dollar icon with the Philippine peso icon in navigation, dashboard, and Revenues screens.
- Updated application, health endpoint, and fresh-install SQL version metadata to 2.06.
- Retained PostgreSQL relational synchronization in the fresh-install package.

## Verification notes

- Automated verification is recorded after packaging below.


## Version 2.04

- Moved per-table export permission checkboxes into each table row in Manage Access Restriction.
- Removed the separate Raw Data Export Permissions section and the Export restricted label.
- Kept Operations Overview visible-section controls unchanged.
- Changed JSON restore to validate the file, send the restored state to the authenticated PostgreSQL API, and wait for the database response before showing success.
- Restricted the client restore operation to Admin users and preserved existing database password hashes when imported agent records omit password values.
- Added `orderStatuses` to the persisted application-state key allowlist so the lookup list is saved and restored with the rest of the CRM state.
- Updated fresh-install metadata and database schema version comments.

## Verification notes

- `node --check server.mjs`: passed.
- `node --test tests/serverData.test.mjs`: 3 tests passed.
- Full TypeScript type-check and production build could not be run in the packaging environment because dependency installation did not complete.
- PostgreSQL schema execution and Docker integration tests could not be run because `psql` and Docker are not installed in the packaging environment.

## v2.08.1 - Blank-screen fix

- Fixed the startup crash caused by references to the unavailable `PhilippinePeso` Lucide icon export.
- Replaced the unavailable icon component with the supported `Wallet` icon and retained the literal Philippine peso glyph (₱) in the relevant sidebar sections.
- Added compatibility handling for previously saved branding configurations that used `PhilippinePeso` or `DollarSign` as an icon name.


## 2.08.3
- Fix ZITADEL/CRM redirect loop by restoring and validating the HttpOnly CRM session before redirecting unauthenticated browsers.
- Rehydrate the non-secret CRM user profile from the server session on page load.
- Keep the callback URL in place until the server confirms the session, then clean the one-time query marker.


## v2.08.11
- Improved Histories IP capture to use the visitor public IP forwarded by a trusted reverse proxy (Cloudflare, True-Client-IP, or X-Real-IP), with validated direct-peer fallback.
- Documented secure TRUST_PROXY configuration and proxy header requirements.
