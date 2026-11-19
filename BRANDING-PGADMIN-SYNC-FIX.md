# Mesina Farms CRM v2.08.11 – Branding/pgAdmin Sync Fix

This update fixes two causes of stale values in **Settings > Company Branding & Administration Settings**:

1. The branding form now reloads its fields whenever it opens and whenever the branding state is refreshed from PostgreSQL.
2. The server now treats the `crm_branding` row with `id = 1` as the authoritative source for company branding. Direct pgAdmin edits to company name, logo, tagline, subtitle, login content/background, favicon, and `table_icon_config` are therefore reflected when the CRM loads state.

## Files changed
- `server.mjs`
- `src/components/AdminBrandingModal.tsx`

## Deployment
1. Back up your PostgreSQL database and current CRM deployment.
2. Replace the two files above in your existing source tree (or deploy the full updated bundle).
3. Rebuild/restart the CRM container using your normal Docker Compose deployment process.
4. Sign out and back in, then open **Settings > Company Branding & Administration Settings**.
5. Confirm the values match `crm_branding` row `id = 1` in pgAdmin.

The CRM's normal Save Branding Changes action continues to write the branding state and mirror it into `crm_branding`. If the row does not exist, the app falls back to the branding stored in `crm_state`.
