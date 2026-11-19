import express from 'express';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { paginateRecords, buildFinancialReconciliation } from './src/utils/serverData.mjs';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
// Trust client-IP forwarding headers only when the app is behind one trusted reverse proxy.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
app.set('trust proxy', TRUST_PROXY ? 1 : false);

function getClientPublicIp(req) {
  // Forwarded headers are only accepted when the deployment explicitly trusts its proxy.
  const candidates = TRUST_PROXY
    ? [req.get('cf-connecting-ip'), req.get('true-client-ip'), req.get('x-real-ip'), req.ip]
    : [req.socket?.remoteAddress, req.ip];
  for (const candidate of candidates) {
    const value = String(candidate || '').split(',')[0].trim().replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
    if (isIP(value)) return value;
  }
  return null;
}
const pool = new Pool({
  host: process.env.PGHOST || 'db',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || process.env.POSTGRES_DB || 'mesina_crm',
  user: process.env.PGUSER || process.env.POSTGRES_USER || 'crm_user',
  password: process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD,
  max: 15,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32 || secret.startsWith('CHANGE_ME')) throw new Error('Set a unique JWT_SECRET of at least 32 characters in .env.');
if (!process.env.POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD.startsWith('CHANGE_ME')) throw new Error('Set a unique POSTGRES_PASSWORD in .env before startup.');
app.disable('x-powered-by');
app.use((req,res,next)=>{ res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Referrer-Policy','strict-origin-when-cross-origin'); res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()'); res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; upgrade-insecure-requests"); next(); });
app.use(express.json({ limit: '25mb' }));

const tableKeys = ['branding','agents','marketPrices','farmRegistries','contactPeople','opportunities','orders','followUpOrders','invoices','deliveries','revenues','histories','opportunityStatuses','followUpStatuses','followUpMethods','deliveryStatuses','paymentStatuses','paymentMethods','orderStatuses','rolePermissions','overviewVisibility','onlineInquiries','onlineInquirySources'];
const tabToState = { dashboard: null, opportunities:'opportunities', orders:'orders', follow_up_orders:'followUpOrders', invoices:'invoices', deliveries:'deliveries', revenues:'revenues', farm_registries:'farmRegistries', contact_people:'contactPeople', agents:'agents', catalog:'marketPrices', histories:'histories', status_tables:['opportunityStatuses','followUpStatuses','followUpMethods','deliveryStatuses','paymentStatuses','paymentMethods'], online_inquiry:'onlineInquiries', online_inquiry_sources:'onlineInquirySources' };
const defaultPermissions = {
  Admin: Object.keys(tabToState),
  'Sales Agent':['dashboard','opportunities','orders','follow_up_orders','farm_registries','contact_people','catalog','online_inquiry'],
  Manager:['dashboard','agents'],
  'Booking Agent':['dashboard','opportunities','orders','follow_up_orders','farm_registries','contact_people','catalog','online_inquiry'],
  'Delivery Agent':['dashboard','orders','deliveries','farm_registries','contact_people'],
};
async function init() {
  // Keep branding fields queryable on databases created by earlier v2.05 builds.
  await pool.query(`ALTER TABLE histories ADD COLUMN IF NOT EXISTS ip_address VARCHAR(100)`);
  await pool.query(`ALTER TABLE crm_branding ADD COLUMN IF NOT EXISTS login_heading varchar(255), ADD COLUMN IF NOT EXISTS login_description text, ADD COLUMN IF NOT EXISTS login_footer varchar(255), ADD COLUMN IF NOT EXISTS login_background_image text, ADD COLUMN IF NOT EXISTS table_icon_config jsonb NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS zitadel_user_id TEXT UNIQUE`);
  // New staff records must wait for explicit Admin approval. This changes only
  // the default for future rows; existing account statuses are not modified.
  await pool.query(`ALTER TABLE agents ALTER COLUMN status SET DEFAULT 'Inactive'`);
  await pool.query(`ALTER TABLE crm_sessions ADD COLUMN IF NOT EXISTS id_token TEXT`);
  await pool.query(`SELECT 1 FROM crm_state, crm_state_records, crm_branding, roles, agents, crm_sessions, auth_login_attempts, crm_audit_events, market_price, opportunity_statuses, fu_orders_statuses, fu_orders_method, delivery_statuses, payment_statuses, paymemt_methods, farm_registries, contact_people, opportunities, online_inquiry_sources, online_inquiry, orders, follow_up_orders, invoices, deliveries, revenues, histories, employees, attendance, obligations_list, obligations, farm_maintenance_list, farm_maintenance, extra_expenses LIMIT 0`);
  // Add the percentage column safely for existing PostgreSQL installations. Fresh installs already include it in the single schema script.
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_percent NUMERIC(5,2) NOT NULL DEFAULT 0.00 CHECK (discount_percent >= 0 AND discount_percent <= 100)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS crm_backup_exports (export_id VARCHAR(36) PRIMARY KEY, admin_agent_id INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), downloaded_at TIMESTAMPTZ, consumed_at TIMESTAMPTZ)`);
  await pool.query("DELETE FROM auth_login_attempts WHERE window_started_at < now()-interval '2 days'");
  const adminCheck = await pool.query("SELECT agent_id FROM agents WHERE username='admin'");
  if (!adminCheck.rowCount) {
    const initialPassword = String(process.env.ADMIN_INITIAL_PASSWORD || '');
    if (initialPassword.length < 12 || initialPassword.startsWith('CHANGE_ME')) throw new Error('Set ADMIN_INITIAL_PASSWORD to a unique password of at least 12 characters before first startup.');
    await pool.query(`INSERT INTO agents (name,email,status,role,username,password,date_started) VALUES ($1,$2,'Active','Admin','admin',$3,now())`, ['Administrator', 'admin@localhost', await bcrypt.hash(initialPassword, 12)]);
  }
  // Load the current CRM document; PostgreSQL master tables remain authoritative.
  const savedState = await pool.query('SELECT state FROM crm_state WHERE id=1');
  // One-time and ongoing reconciliation: migrate the currently saved CRM
  // document into real PostgreSQL tables on startup, including existing data.
  if (savedState.rows[0]?.state) {
    const syncClient = await pool.connect();
    try {
      await syncClient.query('BEGIN');
      await syncRelationalCollections(syncClient, savedState.rows[0].state);
      await syncClient.query('COMMIT');
    } catch (error) {
      await syncClient.query('ROLLBACK');
      throw error;
    } finally { syncClient.release(); }
  }
  // The roles table is authoritative. Do not recreate deleted role rows from stale
  // crm_state.rolePermissions keys during startup; the browser refreshes and prunes those keys.
  const savedAgents = savedState.rows[0]?.state?.agents;
  if (Array.isArray(savedAgents)) {
    for (const agent of savedAgents) {
      if (!agent.agent_id || !agent.username || !agent.name || !agent.role) continue;
      const existingAgent = await pool.query('SELECT agent_id,password FROM agents WHERE agent_id=$1 OR lower(username)=lower($2) LIMIT 1',[agent.agent_id,agent.username]);
      if (existingAgent.rowCount) {
        // Keep identity-provider-managed username/email out of the legacy state migration.
        await pool.query(`UPDATE agents SET name=$1,address=$2,phone=$3,status=$4,role=$5,
          password=CASE WHEN $6<>'' THEN $6 ELSE password END,date_started=$7,avatar_url=COALESCE($8,avatar_url)
          WHERE agent_id=$9`,[agent.name,agent.address||null,agent.phone||null,agent.status||'Active',agent.role,agent.password||'',agent.date_started||new Date().toISOString(),agent.avatar_url||null,existingAgent.rows[0].agent_id]);
      }
    }
    await pool.query(`SELECT setval(pg_get_serial_sequence('agents','agent_id')::regclass,
      GREATEST(COALESCE((SELECT MAX(agent_id) FROM agents WHERE agent_id < 1000000000000),1),1),true)`);
  }
}
async function signToken(agent, idToken = null) {
  const jti = crypto.randomUUID();
  const exp = Math.floor(Date.now()/1000)+60*60*12;
  const payload = Buffer.from(JSON.stringify({ sub: agent.agent_id, role: agent.role, jti, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  await pool.query('INSERT INTO crm_sessions(token_id,agent_id,expires_at,id_token) VALUES($1,$2,to_timestamp($3),$4)',[jti,agent.agent_id,exp,idToken]);
  return `${payload}.${sig}`;
}
async function auth(req,res,next) {
  try {
    const bearerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
    const cookieToken = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('crm_session='))?.slice('crm_session='.length);
    const token = cookieToken ? decodeURIComponent(cookieToken) : bearerToken;
    const [payload,sig] = token.split('.');
    if (!payload || !sig) return res.status(401).json({error:'Authentication required'});
    const expected = crypto.createHmac('sha256',secret).update(payload).digest();
    const actual = Buffer.from(sig,'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual,expected)) return res.status(401).json({error:'Invalid session'});
    const data = JSON.parse(Buffer.from(payload,'base64url').toString());
    if (data.exp < Date.now()/1000) return res.status(401).json({error:'Session expired'});
    const session = await pool.query('SELECT 1 FROM crm_sessions WHERE token_id=$1 AND agent_id=$2 AND expires_at>now()',[data.jti,data.sub]);
    if (!session.rowCount) return res.status(401).json({error:'Session expired or revoked'});
    const { rows } = await pool.query('SELECT agent_id,name,role,username,status,email,phone,address,date_started,avatar_url,zitadel_user_id FROM agents WHERE agent_id=$1 AND status=$2',[data.sub,'Active']);
    if (!rows[0]) return res.status(401).json({error:'Account unavailable'});
    req.user = { ...rows[0], auth_provider: rows[0].zitadel_user_id ? 'zitadel' : 'local' }; req.token = token; next();
  } catch { return res.status(401).json({error:'Invalid session'}); }
}
async function getState() {
  const result = await pool.query('SELECT state FROM crm_state WHERE id=1');
  const state = result.rows[0]?.state || null;
  if (!state) return null;

  // crm_branding is the normalized PostgreSQL source of truth for company
  // identity and visual settings. This also makes direct pgAdmin edits visible
  // without requiring a separate browser-state migration.
  const brandingResult = await pool.query(
    `SELECT id, company_name, company_logo, tagline, subtitle,
            login_heading, login_description, login_footer,
            login_background_image, favicon, table_icon_config, updated_at
       FROM crm_branding
      WHERE id = 1
      LIMIT 1`
  );
  const brandingRow = brandingResult.rows[0];
  if (brandingRow) {
    state.branding = {
      ...(state.branding || {}),
      ...brandingRow,
      id: Number(brandingRow.id),
      table_icon_config: brandingRow.table_icon_config || {},
    };
  }
  return state;
}
const mirroredCollections = ['agents','marketPrices','farmRegistries','contactPeople','opportunities','orders','followUpOrders','invoices','deliveries','revenues','histories','opportunityStatuses','followUpStatuses','followUpMethods','deliveryStatuses','paymentStatuses','paymentMethods','orderStatuses','onlineInquiries','onlineInquirySources'];
async function refreshStateRecordMirror(client, state) {
  await client.query('DELETE FROM crm_state_records');
  for (const key of mirroredCollections) {
    const rows = Array.isArray(state?.[key]) ? state[key] : [];
    for (let i=0; i<rows.length; i++) {
      const row = rows[i] || {};
      const idField = Object.keys(row).find(k => /(^id$|_id$)/i.test(k));
      const recordKey = String(idField && row[idField] != null ? row[idField] : i+1);
      await client.query('INSERT INTO crm_state_records(table_name,record_key,data) VALUES($1,$2,$3::jsonb)', [key,recordKey,JSON.stringify(row)]);
    }
  }
}


// Persist the JSON state snapshot into the normalized PostgreSQL tables as well.
// The CRM UI still uses its state document, but pgAdmin users can inspect and
// query the same records in the corresponding relational tables.
const relationalCollections = [
  { key:'branding', table:'crm_branding', pk:'id', object:true, fields:{ id:'id', company_name:'company_name', company_logo:'company_logo', tagline:'tagline', subtitle:'subtitle', login_heading:'login_heading', login_description:'login_description', login_footer:'login_footer', login_background_image:'login_background_image', favicon:'favicon', table_icon_config:'table_icon_config', updated_at:'updated_at' }, json:['table_icon_config'] },
  { key:'marketPrices', table:'market_price', pk:'market_price_id', id:'market_price_id', fields:{ market_price_id:'market_price_id', name:'name', description:'description', price:'price', unit:'unit', notes:'notes' } },
  { key:'farmRegistries', table:'farm_registries', pk:'farm_id', id:'farm_id', fields:{ farm_id:'farm_id', farm_name:'farm_name', farm_address:'farm_address', coordinates_lat_lng:'coordinates_lat_lng', designated_point_person:'designated_point_person', farm_phone:'farm_phone', farm_email:'farm_email', date_created:'date_created', assigned_agent:'assigned_agent' } },
  { key:'contactPeople', table:'contact_people', pk:'contact_id', id:'contact_id', fields:{ contact_id:'contact_id', contact_person_name:'contact_person_name', farm_name:'farm_name', is_point_person:'is_point_person', phone_number:'phone_number', email_address:'email_address', address:'address', is_active:'is_active', date_created:'date_created', assigned_agent:'assigned_agent' } },
  { key:'opportunities', table:'opportunities', pk:'opportunity_id', id:'opportunity_id', fields:{ opportunity_id:'opportunity_id', contact_id:'contact_id', contact_person:'contact_person', phone:'phone', fish_category:'fish_category', quantity:'quantity', status:'status', contacted_by:'contacted_by', source:'source', date_created:'date_created', notes:'notes' } },
  { key:'orders', table:'orders', pk:'order_id', id:'order_id', fields:{ order_id:'order_id', opportunity_id:'opportunity_id', farm_name:'farm_name', contact_person:'contact_person', fish_category:'fish_category', quantity:'quantity', price:'price', price_unit:'price_unit', discount:'discount', discount_percent:'discount_percent', discount_enabled:'discount_enabled', total_price:'total_price', order_date:'order_date', delivery_date:'delivery_date', status:'status', booking_agent:'booking_agent', notes:'notes' } },
  { key:'followUpOrders', table:'follow_up_orders', pk:'follow_up_orders_id', id:'follow_up_orders_id', fields:{ follow_up_orders_id:'follow_up_orders_id', order_id:'order_id', opportunity_id:'opportunity_id', farm_name:'farm_name', contact_person_name:'contact_person_name', contact_number:'contact_number', contact_email:'contact_email', date_of_inquiry:'date_of_inquiry', fish_category:'fish_category', quantity:'quantity', status:'status', verified_up_by:'verified_up_by', delivery_date:'delivery_date', landmarks:'landmarks', notes:'notes' } },
  { key:'invoices', table:'invoices', pk:'invoice_id', id:'invoice_id', fields:{ invoice_id:'invoice_id', follow_up_orders_id:'follow_up_orders_id', order_id:'order_id', official_receipt_id:'official_receipt_id', farm_name:'farm_name', contact_person_name:'contact_person_name', fish_category:'fish_category', quantity:'quantity', item_price_per_piece:'item_price_per_piece', item_unit:'item_unit', subtotal:'subtotal', discount:'discount', discount_enabled:'discount_enabled', pricing_snapshot:'pricing_snapshot', total_price:'total_price', or_issued_by:'or_issued_by', payment_received_by:'payment_received_by', payment_method:'payment_method', payment_status:'payment_status', date_created:'date_created', delivery_date:'delivery_date', notes:'notes' }, json:['pricing_snapshot'] },
  { key:'deliveries', table:'deliveries', pk:'delivery_id', id:'delivery_id', fields:{ delivery_id:'delivery_id', invoice_id:'invoice_id', farm_name:'farm_name', farm_address:'farm_address', farm_phone:'farm_phone', farm_gps_coordinates:'farm_gps_coordinates', delivered_by:'delivered_by', status:'status', payment_collected_by:'payment_collected_by', payment_method:'payment_method', payment_status:'payment_status', fulfillment_accepted_by:'fulfillment_accepted_by', landmarks:'landmarks', delivery_notes:'delivery_notes', date_created:'date_created', delivery_date:'delivery_date', delivered_date:'delivered_date' } },
  { key:'revenues', table:'revenues', pk:'revenue_id', id:'revenue_id', fields:{ revenue_id:'revenue_id', invoice_id:'invoice_id', delivery_id:'delivery_id', delivery_status:'delivery_status', payment_collected_by:'payment_collected_by', revenue_amount:'revenue_amount', payment_method:'payment_method', delivered_date:'delivered_date' } },
  { key:'histories', table:'histories', pk:'history_id', id:'history_id', fields:{ history_id:'history_id', table_name:'table_name', modified_field:'modified_field', old_value:'old_value', new_value:'new_value', action_type:'action_type', date_and_time:'date_and_time', modifying_agent:'modifying_agent', ip_address:'ip_address' } },
  { key:'opportunityStatuses', table:'opportunity_statuses', pk:'opportunity_status_id', id:'id', fields:{ opportunity_status_id:'id', name:'name', description:'description' } },
  { key:'followUpStatuses', table:'fu_orders_statuses', pk:'fu_opportunities_status_id', id:'id', fields:{ fu_opportunities_status_id:'id', name:'name', description:'description' } },
  { key:'followUpMethods', table:'fu_orders_method', pk:'fu_orders_method_id', id:'id', fields:{ fu_orders_method_id:'id', name:'name', description:'description' } },
  { key:'deliveryStatuses', table:'delivery_statuses', pk:'delivery_status_id', id:'id', fields:{ delivery_status_id:'id', name:'name', description:'description' } },
  { key:'paymentStatuses', table:'payment_statuses', pk:'payment_status_id', id:'id', fields:{ payment_status_id:'id', name:'name', description:'description' } },
  { key:'paymentMethods', table:'paymemt_methods', pk:'payment_methods_id', id:'id', fields:{ payment_methods_id:'id', name:'name', description:'description' } },
  { key:'orderStatuses', table:'order_statuses', pk:'id', id:'id', fields:{ id:'id', name:'name', description:'description' } },
];
async function syncRelationalCollections(client, state) {
  // Parent/reference records are upserted first so FK-backed rows can follow.
  const priority = ['branding','marketPrices','opportunityStatuses','followUpStatuses','followUpMethods','deliveryStatuses','paymentStatuses','paymentMethods','orderStatuses','farmRegistries','contactPeople','opportunities','orders','followUpOrders','invoices','deliveries','revenues','histories'];
  const syncOrder = [...relationalCollections].sort((a,b) => priority.indexOf(a.key) - priority.indexOf(b.key));
  for (const cfg of syncOrder) {
    if (!Object.hasOwn(state || {}, cfg.key)) continue;
    const source = cfg.object ? (state[cfg.key] ? [state[cfg.key]] : []) : (Array.isArray(state[cfg.key]) ? state[cfg.key] : []);
    for (const row of source) {
      if (!row || typeof row !== 'object') continue;
      const normalizedRow = cfg.key === 'histories' ? { ...row, table_name:row.table_name || row.entry_table, modified_field:row.modified_field || row.field_name, modifying_agent:row.modifying_agent || row.modifiers_name } : row;
      const entries = Object.entries(cfg.fields).filter(([column, sourceKey]) => normalizedRow[sourceKey] !== undefined);
      if (!entries.length) continue;
      const columns = entries.map(([column]) => column);
      const values = entries.map(([column, sourceKey]) => cfg.json?.includes(column) ? JSON.stringify(normalizedRow[sourceKey] ?? {}) : normalizedRow[sourceKey]);
      const placeholders = entries.map(([column], i) => `$${i+1}${cfg.json?.includes(column) ? '::jsonb' : ''}`);
      const updates = columns.filter(column => column !== cfg.pk).map(column => `${column}=EXCLUDED.${column}`);
      const sql = `INSERT INTO ${cfg.table} (${columns.join(',')}) VALUES (${placeholders.join(',')}) ON CONFLICT (${cfg.pk}) DO ${updates.length ? `UPDATE SET ${updates.join(',')}` : 'NOTHING'}`;
      await client.query(sql, values);
    }
  }
  // Remove rows deleted in the CRM, in reverse FK dependency order.
  for (const cfg of [...syncOrder].reverse()) {
    if (!Object.hasOwn(state || {}, cfg.key)) continue;
    const source = cfg.object ? (state[cfg.key] ? [state[cfg.key]] : []) : (Array.isArray(state[cfg.key]) ? state[cfg.key] : []);
    const ids = source.map(row => Number(row?.[cfg.id || cfg.pk])).filter(Number.isSafeInteger);
    await client.query(`DELETE FROM ${cfg.table} WHERE NOT (${cfg.pk} = ANY($1::bigint[]))`, [ids]);
  }
  // Serial sequences must advance past IDs supplied by the browser state.
  for (const cfg of syncOrder) {
    if (!cfg.id || cfg.object) continue;
    const seq = await client.query('SELECT pg_get_serial_sequence($1,$2) AS seq', [cfg.table,cfg.pk]);
    if (seq.rows[0]?.seq) await client.query(`SELECT setval($1::regclass, GREATEST(COALESCE((SELECT MAX(${cfg.pk}) FROM ${cfg.table}),1),1), true)`, [seq.rows[0].seq]);
  }
}

async function writeAuditEvent(user, action, entity, changedKeys = [], recordCounts = {}) {
  await pool.query('INSERT INTO crm_audit_events(actor_agent_id,actor_name,action,entity,changed_keys,record_counts) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [user?.agent_id ?? null, user?.name || 'System', action, entity, JSON.stringify(changedKeys), JSON.stringify(recordCounts)]);
}
function normalizedRole(role) { return String(role || '').trim().toLowerCase(); }
function isAdminUser(user) { return normalizedRole(user?.role) === 'admin'; }
function isPrivilegedAgentRole(role) { return ['admin','manager'].includes(normalizedRole(role)); }
function isManagerUser(user) { return normalizedRole(user?.role) === 'manager'; }
function isAssignableRole(role,state) {
  if (isPrivilegedAgentRole(role)) return false;
  const configured = configuredRoleEntry(role,state);
  return configured.found;
}
function configuredRoleEntry(role,state) {
  const permissions = state?.rolePermissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return { found:false, value:undefined };
  const key = Object.keys(permissions).find(name => normalizedRole(name) === normalizedRole(role));
  return key === undefined ? { found:false, value:undefined } : { found:true, value:permissions[key] };
}
function allowedTabs(user,state) {
  if (isAdminUser(user)) return Object.keys(tabToState);
  const configured = configuredRoleEntry(user?.role,state);
  if (configured.found) return Array.isArray(configured.value) ? configured.value.filter(value => typeof value === 'string') : [];
  const legacyKey = Object.keys(defaultPermissions).find(name => normalizedRole(name) === normalizedRole(user?.role));
  return legacyKey ? [...defaultPermissions[legacyKey]] : ['dashboard'];
}
const childStatusKeys = {
  opportunityStatuses:'status_tables:opportunityStatuses', followUpStatuses:'status_tables:followUpStatuses',
  followUpMethods:'status_tables:followUpMethods', deliveryStatuses:'status_tables:deliveryStatuses',
  paymentStatuses:'status_tables:paymentStatuses', paymentMethods:'status_tables:paymentMethods',
  orderStatuses:'status_tables:orderStatuses'
};
function canAccessKey(key,tabs,state,user,{write=false}={}) {
  if (isAdminUser(user)) return true;
  if (key === 'rolePermissions') return false;
  if (key === 'branding') return !write;
  if (key === 'overviewVisibility') return true;
  // Agent-account management is reserved for Admin and Manager, and still requires the Agents tab.
  if (key === 'agents' && write) return isManagerUser(user) && tabs.includes('agents');
  if (key in childStatusKeys) {
    const roleEntry = configuredRoleEntry(user?.role,state);
    const roleAccess = roleEntry.found && Array.isArray(roleEntry.value) ? roleEntry.value : tabs;
    const granular = roleAccess.some(value => value.startsWith('status_tables:'));
    return tabs.includes('status_tables') && (!granular || roleAccess.includes(childStatusKeys[key]));
  }
  const tab = Object.entries(tabToState).find(([,value]) => value === key)?.[0];
  // Fail closed: state keys without an explicit tab mapping are never exposed to non-admins.
  return Boolean(tab && tabs.includes(tab));
}
function requireTabPermission(tab) {
  return async (req,res,next) => {
    try {
      const state = await getState();
      const tabs = allowedTabs(req.user,state);
      if (!tabs.includes(tab)) return res.status(403).json({error:'You do not have permission to access this section.'});
      next();
    } catch (error) {
      console.error(`Permission check failed for ${tab}:`,error);
      res.status(500).json({error:'Unable to verify access permissions.'});
    }
  };
}

const expenseTables = {
  weekly_attendance: { table:'employees', fields:[] }, salaries: { table:'employees', fields:[] },
  employees: { table:'employees', fields:['name','address','birthdate','tin','work_location','role','is_active','hire_date','end_date','added_by_agent','hourly_rate'] },
  attendance: { table:'attendance', fields:['employee_id','time_in','time_out','notes','added_by_agent'] },
  obligations_list: { table:'obligations_list', fields:['name','description'] },
  obligations: { table:'obligations', fields:['name','cost','date','receipt','company','notes','status','added_by_agent'] },
  farm_maintenance: { table:'farm_maintenance', fields:['name','cost','date','receipt','company','status','notes','added_by_agent'] },
  farm_maintenance_list: { table:'farm_maintenance_list', fields:['name','description'] },
  extra_expenses: { table:'extra_expenses', fields:['name','cost','date','receipt','company','status','description','added_by_agent'] },
};
async function requireExpensePermission(req,res,next) {
  try {
    if (req.user?.role === 'Admin') return next();
    const state = await getState();
    const tabs = allowedTabs(req.user, state);
    if (!tabs.includes(req.params.kind)) return res.status(403).json({error:'You do not have permission to access this expenses table.'});
    next();
  } catch (e) { res.status(500).json({error:'Unable to verify expenses permissions'}); }
}
app.get('/api/expenses/:kind', auth, requireExpensePermission, async (req,res) => {
  const cfg=expenseTables[req.params.kind]; if(!cfg) return res.status(404).json({error:'Unknown expenses table'});
  try {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    const requestedStart = String(req.query.startDate || '');
    const requestedEnd = String(req.query.endDate || '');
    if ((requestedStart && !datePattern.test(requestedStart)) || (requestedEnd && !datePattern.test(requestedEnd))) return res.status(400).json({error:'Dates must use YYYY-MM-DD format'});
    if (requestedStart && requestedEnd && requestedStart > requestedEnd) return res.status(400).json({error:'Start date must be on or before end date'});
    if(req.params.kind==='attendance') {
      const r=await pool.query(`SELECT a.id,a.employee_id,e.name AS employee_name,a.time_in,a.time_out,a.notes,a.added_by_agent,
        CASE WHEN a.time_out IS NULL THEN 0 ELSE ROUND((EXTRACT(EPOCH FROM (a.time_out-a.time_in))/3600)::numeric,2) END AS work_hours
        FROM attendance a JOIN employees e ON e.id=a.employee_id ORDER BY a.time_in DESC`);
      return res.json({rows:r.rows});
    }
    if(req.params.kind==='employees') {
      const r=await pool.query('SELECT * FROM employees ORDER BY id DESC'); return res.json({rows:r.rows});
    }
    if(req.params.kind==='weekly_attendance' || req.params.kind==='salaries') {
      const start = requestedStart || null, end = requestedEnd || null;
      const range = `a.time_in >= COALESCE($1::date, date_trunc('week',CURRENT_DATE)::date)
        AND a.time_in < COALESCE($2::date + interval '1 day', date_trunc('week',CURRENT_DATE)::date + interval '1 week')`;
      const select = req.params.kind==='salaries'
        ? `SELECT e.id AS employee_id,e.name,e.hourly_rate AS rate,
            COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (a.time_out-a.time_in))/3600)::numeric,2),0) AS total_hours,
            COALESCE(ROUND(e.hourly_rate*SUM(EXTRACT(EPOCH FROM (a.time_out-a.time_in))/3600)::numeric,2),0) AS salary`
        : `SELECT e.id AS employee_id,e.name AS employee_name,
            COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (a.time_out-a.time_in))/3600)::numeric,2),0) AS total_work_hours`;
      const r=await pool.query(`${select}
        FROM employees e LEFT JOIN attendance a ON a.employee_id=e.id AND a.time_out IS NOT NULL AND ${range}
        GROUP BY e.id,e.name${req.params.kind==='salaries'?',e.hourly_rate':''} ORDER BY e.name`,[start,end]);
      return res.json({rows:r.rows,startDate:start,endDate:end});
    }
    const r=await pool.query(`SELECT * FROM ${cfg.table} ORDER BY id DESC`); res.json({rows:r.rows});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.post('/api/expenses/:kind', auth, requireExpensePermission, async(req,res)=>{
  const cfg=expenseTables[req.params.kind]; if(!cfg) return res.status(404).json({error:'Unknown expenses table'});
  if(['weekly_attendance','salaries'].includes(req.params.kind)) return res.status(405).json({error:'This report is calculated automatically.'});
  const body=req.body||{}; const fields=cfg.fields.filter(k=>Object.hasOwn(body,k));
  if(!fields.length) return res.status(400).json({error:'No valid fields supplied'});
  try {
    const values=fields.map(k=>body[k]=== '' ? null : body[k]);
    const sql=`INSERT INTO ${cfg.table} (${fields.join(',')}) VALUES (${fields.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`;
    const r=await pool.query(sql,values); await writeAuditEvent(req.user,'CREATE',`expenses:${req.params.kind}`,fields); res.status(201).json({row:r.rows[0]});
  } catch(e) { res.status(400).json({error:e.message}); }
});
app.put('/api/expenses/:kind/:id', auth, requireExpensePermission, async(req,res)=>{
  const cfg=expenseTables[req.params.kind]; if(!cfg) return res.status(404).json({error:'Unknown expenses table'});
  if(['weekly_attendance','salaries'].includes(req.params.kind)) return res.status(405).json({error:'This report is calculated automatically.'});
  const fields=cfg.fields.filter(k=>Object.hasOwn(req.body||{},k)); if(!fields.length) return res.status(400).json({error:'No valid fields supplied'});
  try { const vals=fields.map(k=>req.body[k]===''?null:req.body[k]); vals.push(Number(req.params.id));
    const r=await pool.query(`UPDATE ${cfg.table} SET ${fields.map((k,i)=>k+'=$'+(i+1)).join(',')} WHERE id=$${vals.length} RETURNING *`,vals);
    if(!r.rowCount) return res.status(404).json({error:'Record not found'}); await writeAuditEvent(req.user,'UPDATE',`expenses:${req.params.kind}`,fields); res.json({row:r.rows[0]});
  } catch(e) { res.status(400).json({error:e.message}); }
});
app.delete('/api/expenses/:kind/:id', auth, requireExpensePermission, async(req,res)=>{
  const cfg=expenseTables[req.params.kind]; if(!cfg) return res.status(404).json({error:'Unknown expenses table'});
  if(['weekly_attendance','salaries'].includes(req.params.kind)) return res.status(405).json({error:'This report is calculated automatically.'});
  try { const r=await pool.query(`DELETE FROM ${cfg.table} WHERE id=$1`,[Number(req.params.id)]); if(!r.rowCount) return res.status(404).json({error:'Record not found'}); await writeAuditEvent(req.user,'DELETE',`expenses:${req.params.kind}`,['id']); res.json({success:true}); }
  catch(e) { res.status(400).json({error:e.message}); }
});
app.get('/api/health', async (_req,res) => { try { await pool.query('SELECT 1'); res.json({status:'ok',version:'2.08.11',database:'connected'}); } catch { res.status(503).json({status:'error',database:'unavailable'}); } });
app.get('/api/backup.sql', auth, async (req,res) => {
  if (!isAdminUser(req.user)) return res.status(403).json({error:'Administrator access required'});
  try {
    const state = await getState();
    if (!state) return res.status(404).json({error:'No CRM data is available to export'});
    const encoded = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
    const sqlLiteral = value => `'${String(value).replace(/'/g, "''")}'`;
    const mirrorSql = [];
    for (const key of mirroredCollections) {
      const rows = Array.isArray(state?.[key]) ? state[key] : [];
      rows.forEach((row, index) => {
        const idField = Object.keys(row || {}).find(k => /(^id$|_id$)/i.test(k));
        const recordKey = String(idField && row[idField] != null ? row[idField] : index+1);
        const rowBase64 = Buffer.from(JSON.stringify(row || {}), 'utf8').toString('base64');
        mirrorSql.push(`INSERT INTO crm_state_records(table_name,record_key,data) VALUES (${sqlLiteral(key)},${sqlLiteral(recordKey)},convert_from(decode('${rowBase64}','base64'),'UTF8')::jsonb);`);
      });
    }
    const sql = `-- Mesina Farms CRM PostgreSQL data backup\n-- Import with pgAdmin Query Tool or the CRM Admin backup importer.\n-- MESINA_CRM_STATE_BASE64:${encoded}\nBEGIN;\nCREATE TABLE IF NOT EXISTS crm_state_records (table_name varchar(80) NOT NULL, record_key text NOT NULL, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(table_name,record_key));\nINSERT INTO crm_state(id,state,updated_at) VALUES (1, convert_from(decode('${encoded}','base64'),'UTF8')::jsonb, now()) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state, updated_at=now();\nDELETE FROM crm_state_records;\n${mirrorSql.join('\n')}\nCOMMIT;\n`;
    const exportId = crypto.randomUUID();
    // Only the most recent completed export may authorize one truncate operation.
    await pool.query('UPDATE crm_backup_exports SET consumed_at=now() WHERE admin_agent_id=$1 AND consumed_at IS NULL',[req.user.agent_id]);
    await pool.query('INSERT INTO crm_backup_exports(export_id,admin_agent_id) VALUES($1,$2)',[exportId,req.user.agent_id]);
    res.setHeader('X-CRM-Backup-Export-Id',exportId);
    res.setHeader('Access-Control-Expose-Headers','X-CRM-Backup-Export-Id');
    res.setHeader('Content-Type','application/sql; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename=mesina_crm_backup_${new Date().toISOString().slice(0,10)}.sql`);
    res.send(sql);
  } catch (error) { console.error('SQL export failed:',error); res.status(500).json({error:'Unable to create SQL backup'}); }
});

// Server-side pagination/search API for gradually moving large tables away from full-state downloads.
const resourceToStateKey = {
  opportunities:'opportunities', orders:'orders', follow_up_orders:'followUpOrders', invoices:'invoices',
  deliveries:'deliveries', revenues:'revenues', farm_registries:'farmRegistries', contact_people:'contactPeople',
  agents:'agents', catalog:'marketPrices', histories:'histories', online_inquiry:'onlineInquiries',
  online_inquiry_sources:'onlineInquirySources'
};
app.get('/api/records/:resource', auth, async (req,res) => {
  const key = resourceToStateKey[req.params.resource];
  if (!key) return res.status(404).json({error:'Unknown CRM resource'});
  try {
    const state = await getState();
    const tabs = allowedTabs(req.user,state);
    if (!canAccessKey(key,tabs,state,req.user)) return res.status(403).json({error:'You do not have permission to access this resource.'});
    let records = Array.isArray(state?.[key]) ? state[key] : [];
    if (key === 'agents' && !isAdminUser(req.user)) records = records.filter(row => !isPrivilegedAgentRole(row.role));
    const result = paginateRecords(records, req.query);
    if (key === 'agents') result.items = result.items.map(({password,...row}) => ({...row,password:''}));
    res.json(result);
  } catch (error) { console.error('Paginated records failed:',error); res.status(500).json({error:'Unable to retrieve records.'}); }
});

app.get('/api/reports/financial-reconciliation', auth, async (req,res) => {
  try {
    const state = await getState();
    const tabs = allowedTabs(req.user,state);
    if (!isAdminUser(req.user) && !(tabs.includes('invoices') && tabs.includes('revenues'))) return res.status(403).json({error:'Invoice and revenue permissions are required.'});
    res.json(buildFinancialReconciliation(state));
  } catch (error) { console.error('Financial reconciliation failed:',error); res.status(500).json({error:'Unable to generate financial reconciliation.'}); }
});

app.get('/api/admin/audit-events', auth, async (req,res) => {
  if (!isAdminUser(req.user)) return res.status(403).json({error:'Administrator access required.'});
  const page = Math.max(1, Math.min(1000000, Number.parseInt(req.query.page || '1',10) || 1));
  const perPage = Math.max(1, Math.min(100, Number.parseInt(req.query.perPage || '50',10) || 50));
  try {
    const count = await pool.query('SELECT COUNT(*)::int AS total FROM crm_audit_events');
    const rows = await pool.query('SELECT event_id,actor_agent_id,actor_name,action,entity,changed_keys,record_counts,created_at FROM crm_audit_events ORDER BY event_id DESC LIMIT $1 OFFSET $2',[perPage,(page-1)*perPage]);
    const total = count.rows[0].total;
    res.json({items:rows.rows,pagination:{page,perPage,total,totalPages:Math.max(1,Math.ceil(total/perPage))}});
  } catch (error) { console.error('Audit events failed:',error); res.status(500).json({error:'Unable to retrieve audit events.'}); }
});

// ZITADEL OIDC: server-side Authorization Code + PKCE. Credentials and tokens never enter
// the browser URL; a short-lived HttpOnly cookie bridges the callback to the existing CRM client.
let oidcMetadataCache = null;
let oidcMetadataFetchedAt = 0;
async function getOidcMetadata() {
  const issuer = String(process.env.ZITADEL_ISSUER || '').replace(/\/+$/, '');
  if (!issuer || !process.env.ZITADEL_CLIENT_ID || !process.env.ZITADEL_CLIENT_SECRET) {
    throw new Error('ZITADEL is not configured. Set ZITADEL_ISSUER, ZITADEL_CLIENT_ID and ZITADEL_CLIENT_SECRET.');
  }
  if (oidcMetadataCache && Date.now() - oidcMetadataFetchedAt < 5 * 60 * 1000) return oidcMetadataCache;
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Unable to load ZITADEL discovery metadata (${response.status}).`);
  const metadata = await response.json();
  if (metadata.issuer !== issuer || !metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.jwks_uri) {
    throw new Error('ZITADEL discovery metadata is invalid or the issuer does not match.');
  }
  oidcMetadataCache = metadata;
  oidcMetadataFetchedAt = Date.now();
  return metadata;
}
function cookieOptions(maxAge) {
  return `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function readCookie(req, name) {
  const item = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}
function base64url(value) { return Buffer.from(value).toString('base64url'); }
function randomVerifier() { return crypto.randomBytes(48).toString('base64url'); }
async function verifyZitadelIdToken(idToken, metadata, expectedNonce) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('ZITADEL returned an invalid ID token.');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (!['RS256','RS384','RS512'].includes(header.alg) || !header.kid) throw new Error('Unsupported ZITADEL ID token signing algorithm.');
  const jwksResponse = await fetch(metadata.jwks_uri, { headers: { Accept: 'application/json' } });
  if (!jwksResponse.ok) throw new Error('Unable to retrieve ZITADEL signing keys.');
  const jwks = await jwksResponse.json();
  const jwk = (jwks.keys || []).find(key => key.kid === header.kid && key.use !== 'enc');
  if (!jwk) throw new Error('ZITADEL signing key was not found.');
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const algorithms = { RS256: 'RSA-SHA256', RS384: 'RSA-SHA384', RS512: 'RSA-SHA512' };
  const verifier = crypto.createVerify(algorithms[header.alg]);
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  if (!verifier.verify(publicKey, Buffer.from(parts[2], 'base64url'))) throw new Error('ZITADEL ID token signature is invalid.');
  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== metadata.issuer || !audience.includes(process.env.ZITADEL_CLIENT_ID) ||
      (audience.length > 1 && claims.azp !== process.env.ZITADEL_CLIENT_ID) ||
      !claims.sub || !claims.exp || claims.exp <= now || (claims.nbf && claims.nbf > now) ||
      claims.nonce !== expectedNonce) throw new Error('ZITADEL ID token claims failed validation.');
  return claims;
}
function safeUsernameFromEmail(email) {
  const base = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 70) || 'zitadel-user';
  return base;
}
function safeUsernameFromClaims(claims, email) {
  const preferred = String(claims?.preferred_username || claims?.nickname || '').trim().toLowerCase();
  const normalized = preferred.replace(/[^a-z0-9._-]/g, '').slice(0, 70);
  return normalized || safeUsernameFromEmail(email);
}
async function syncProvisionedAgentToState(user) {
  const currentState = await getState();
  if (!currentState) return;
  const safeAgent = { ...user, password: '' };
  currentState.agents = [...(Array.isArray(currentState.agents) ? currentState.agents : []).filter(row => Number(row.agent_id) !== Number(user.agent_id)), safeAgent];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE crm_state SET state=$1::jsonb,updated_at=now() WHERE id=1', [JSON.stringify(currentState)]);
    await refreshStateRecordMirror(client, currentState);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function provisionZitadelAgent(claims) {
  const subject = String(claims.sub);
  const email = String(claims.email || '').trim().toLowerCase();
  if (!email || claims.email_verified !== true) throw new Error('A verified email address is required in your ZITADEL account. Ask your ZITADEL administrator to verify the email and include the email scope.');
  const displayName = String(claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || email).trim().slice(0, 255);
  // OIDC's standard `picture` claim is supplied by ZITADEL's UserInfo endpoint
  // when the profile scope and a profile image are available. Only accept HTTPS URLs.
  let zitadelPicture = null;
  if (typeof claims.picture === 'string' && claims.picture.trim()) {
    try {
      const pictureUrl = new URL(claims.picture.trim());
      if (pictureUrl.protocol === 'https:' && pictureUrl.href.length <= 2048) zitadelPicture = pictureUrl.href;
    } catch { /* Ignore malformed identity-provider picture claims. */ }
  }
  const existing = await pool.query(`SELECT agent_id,name,role,username,status,email,phone,address,date_started,avatar_url
    FROM agents WHERE zitadel_user_id=$1`, [subject]);
  if (existing.rowCount) {
    const user = existing.rows[0];
    if (user.status !== 'Active') throw new Error('Your CRM staff account is inactive. Contact a CRM administrator.');
    // ZITADEL is authoritative for identity fields. CRM contact details and role remain local.
    const identityUsername = safeUsernameFromClaims(claims, email);
    const usernameOwner = await pool.query('SELECT agent_id FROM agents WHERE lower(username)=lower($1) AND agent_id<>$2 LIMIT 1', [identityUsername, user.agent_id]);
    if (usernameOwner.rowCount) throw new Error('Your ZITADEL username is already assigned to another CRM account. Contact a CRM administrator.');
    const updated = await pool.query(`UPDATE agents SET email=$1,username=$2,avatar_url=COALESCE($3,avatar_url)
      WHERE agent_id=$4 RETURNING agent_id,name,role,username,status,email,phone,address,date_started,avatar_url`,
      [email, identityUsername, zitadelPicture, user.agent_id]);
    await syncProvisionedAgentToState(updated.rows[0]);
    return updated.rows[0];
  }
  // First-login administrator bootstrap: explicitly configured email can claim the existing
  // seeded Admin row once. This is never inferred from a ZITADEL role or unverified email.
  const bootstrapAdminEmail = String(process.env.ZITADEL_BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
  if (bootstrapAdminEmail && email === bootstrapAdminEmail) {
    const admin = await pool.query(`SELECT agent_id,name,role,username,status,email,phone,address,date_started,avatar_url,zitadel_user_id
      FROM agents WHERE role='Admin' AND zitadel_user_id IS NULL ORDER BY agent_id LIMIT 1`);
    if (admin.rowCount) {
      const row = admin.rows[0];
      const identityUsername = safeUsernameFromClaims(claims, email);
      const usernameOwner = await pool.query('SELECT agent_id FROM agents WHERE lower(username)=lower($1) AND agent_id<>$2 LIMIT 1', [identityUsername, row.agent_id]);
      if (usernameOwner.rowCount) throw new Error('Your ZITADEL username is already assigned to another CRM account. Contact a CRM administrator.');
      const linkedAdmin = await pool.query(`UPDATE agents SET zitadel_user_id=$1,email=$2,username=$3,avatar_url=COALESCE($4,avatar_url) WHERE agent_id=$5
        RETURNING agent_id,name,role,username,status,email,phone,address,date_started,avatar_url`, [subject,email,identityUsername,zitadelPicture,row.agent_id]);
      await syncProvisionedAgentToState(linkedAdmin.rows[0]);
      return linkedAdmin.rows[0];
    }
  }
  // Link an existing staff record only by a verified, exact email match and only if it is not
  // already linked to another ZITADEL identity. This preserves pre-existing CRM roles.
  const byEmail = await pool.query(`SELECT agent_id,name,role,username,status,email,phone,address,date_started,avatar_url,zitadel_user_id
    FROM agents WHERE lower(email)=lower($1) LIMIT 1`, [email]);
  if (byEmail.rowCount) {
    const user = byEmail.rows[0];
    if (user.zitadel_user_id && user.zitadel_user_id !== subject) throw new Error('This email is already linked to another ZITADEL identity. Contact a CRM administrator.');
    if (user.status !== 'Active') throw new Error('Your CRM staff account is inactive. Contact a CRM administrator.');
    const identityUsername = safeUsernameFromClaims(claims, email);
    const usernameOwner = await pool.query('SELECT agent_id FROM agents WHERE lower(username)=lower($1) AND agent_id<>$2 LIMIT 1', [identityUsername, user.agent_id]);
    if (usernameOwner.rowCount) throw new Error('Your ZITADEL username is already assigned to another CRM account. Contact a CRM administrator.');
    const linked = await pool.query(`UPDATE agents SET zitadel_user_id=$1,email=$2,username=$3,avatar_url=COALESCE($4,avatar_url) WHERE agent_id=$5
      RETURNING agent_id,name,role,username,status,email,phone,address,date_started,avatar_url`, [subject,email,identityUsername,zitadelPicture,user.agent_id]);
    await syncProvisionedAgentToState(linked.rows[0]);
    return linked.rows[0];
  }
  // New identities are deliberately least-privileged. CRM administrators can change role/access
  // after the staff record is provisioned. A random unusable password preserves legacy schema.
  const role = String(process.env.ZITADEL_DEFAULT_CRM_ROLE || 'Sales Agent').trim();
  const roleExists = await pool.query('SELECT 1 FROM roles WHERE name=$1', [role]);
  if (!roleExists.rowCount || ['Admin','Manager'].includes(role)) throw new Error('The configured ZITADEL default CRM role must be an existing non-privileged role.');
  const usernameBase = safeUsernameFromClaims(claims, email);
  let username = usernameBase;
  for (let suffix = 1; ; suffix++) {
    const collision = await pool.query('SELECT 1 FROM agents WHERE lower(username)=lower($1)', [username]);
    if (!collision.rowCount) break;
    username = `${usernameBase.slice(0, 85)}-${suffix}`;
  }
  const unusablePassword = await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 12);
  const inserted = await pool.query(`INSERT INTO agents(name,email,status,role,username,password,date_started,zitadel_user_id,avatar_url)
    VALUES($1,$2,'Inactive',$3,$4,$5,now(),$6,$7)
    RETURNING agent_id,name,role,username,status,email,phone,address,date_started,avatar_url`,
    [displayName,email,role,username,unusablePassword,subject,zitadelPicture]);
  const provisioned = inserted.rows[0];
  await syncProvisionedAgentToState(provisioned);
  // Do not create a CRM session for a newly provisioned identity. An Admin must
  // explicitly activate the account in Agents before its next ZITADEL login.
  throw new Error('Your CRM account has been created and is awaiting administrator approval. Please contact a CRM administrator.');
}
app.get('/api/auth/zitadel', async (req,res) => {
  try {
    const metadata = await getOidcMetadata();
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const verifier = randomVerifier();
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    res.setHeader('Set-Cookie', [
      `crm_oidc_state=${encodeURIComponent(state)}; ${cookieOptions(600)}`,
      `crm_oidc_nonce=${encodeURIComponent(nonce)}; ${cookieOptions(600)}`,
      `crm_oidc_verifier=${encodeURIComponent(verifier)}; ${cookieOptions(600)}`
    ]);
    const redirectUri = process.env.ZITADEL_REDIRECT_URI || `${process.env.CRM_PUBLIC_URL || 'https://crm.mesina.farm'}/api/auth/callback/zitadel`;
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: process.env.ZITADEL_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state, nonce
    }).toString();
    res.redirect(url.toString());
  } catch (error) {
    console.error('ZITADEL login initialization failed:', error.message);
    res.status(503).send('ZITADEL login is not configured or is temporarily unavailable. Contact your administrator.');
  }
});
app.get('/api/auth/callback/zitadel', async (req,res) => {
  try {
    const expectedState = readCookie(req, 'crm_oidc_state');
    const expectedNonce = readCookie(req, 'crm_oidc_nonce');
    const verifier = readCookie(req, 'crm_oidc_verifier');
    res.setHeader('Set-Cookie', [
      `crm_oidc_state=; ${cookieOptions(0)}`,
      `crm_oidc_nonce=; ${cookieOptions(0)}`,
      `crm_oidc_verifier=; ${cookieOptions(0)}`
    ]);
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    if (!expectedState || !expectedNonce || !verifier || req.query.state !== expectedState || !req.query.code) throw new Error('The ZITADEL login response could not be verified. Please try again.');
    const metadata = await getOidcMetadata();
    const redirectUri = process.env.ZITADEL_REDIRECT_URI || `${process.env.CRM_PUBLIC_URL || 'https://crm.mesina.farm'}/api/auth/callback/zitadel`;
    const tokenResponse = await fetch(metadata.token_endpoint, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(req.query.code),
        redirect_uri: redirectUri,
        code_verifier: verifier
      }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${process.env.ZITADEL_CLIENT_ID}:${process.env.ZITADEL_CLIENT_SECRET}`).toString('base64')}`
      }
    });
    const tokens = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokens.id_token) throw new Error(tokens.error_description || 'ZITADEL token exchange failed.');
    const claims = await verifyZitadelIdToken(tokens.id_token, metadata, expectedNonce);
    let identityClaims = claims;
    // ZITADEL may omit profile/email claims from the ID token when an access token is issued.
    // Retrieve the scoped identity claims from UserInfo and require the same subject.
    if (metadata.userinfo_endpoint && tokens.access_token) {
      const userInfoResponse = await fetch(metadata.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' }
      });
      if (!userInfoResponse.ok) throw new Error('Unable to retrieve verified user information from ZITADEL.');
      const userInfo = await userInfoResponse.json();
      if (userInfo.sub !== claims.sub) throw new Error('ZITADEL UserInfo subject does not match the authenticated identity.');
      identityClaims = { ...claims, ...userInfo };
    }
    const user = await provisionZitadelAgent(identityClaims);
    const token = await signToken(user, tokens.id_token);
    res.setHeader('Set-Cookie', [
      ...(res.getHeader('Set-Cookie') || []),
      `crm_session=${encodeURIComponent(token)}; ${cookieOptions(60 * 60 * 12)}`
    ]);
    res.redirect('/?zitadel_login=complete');
  } catch (error) {
    console.error('ZITADEL callback failed:', error.message);
    const pendingApproval = /inactive|awaiting administrator approval/i.test(String(error.message || ''));
    res.redirect(pendingApproval ? '/?auth_error=pending_approval' : '/?auth_error=zitadel');
  }
});
app.get('/api/auth/bootstrap', auth, async (req,res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { password, zitadel_user_id, ...user } = req.user;
  res.json({ user });
});
app.post('/api/auth/login', async (_req,res) => res.status(410).json({error:'Password login has been replaced by ZITADEL. Use the ZITADEL sign-in button.'}));
app.get('/api/me',auth,async(req,res)=>{ const {password,zitadel_user_id,...user}=req.user; res.json({user}); });
app.get('/api/roles', auth, async (req,res) => {
  try {
    const result = await pool.query('SELECT name FROM roles ORDER BY lower(name), name');
    let names = result.rows.map(row => String(row.name || '').trim()).filter(Boolean);
    if (!isAdminUser(req.user)) names = names.filter(name => !isPrivilegedAgentRole(name));
    if (!isAdminUser(req.user) && !isManagerUser(req.user)) names = names.filter(name => name === req.user.role);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ roles: names });
  } catch (error) {
    console.error('Could not load CRM roles:', error.message);
    res.status(500).json({ error: 'Could not load CRM roles' });
  }
});
app.get('/api/state',auth,async(req,res)=>{
  const state=await getState();
  if(!state) { if(!isAdminUser(req.user)) return res.status(409).json({error:'CRM has not been initialized. Ask an administrator to sign in first.'}); return res.json({state:null,allowedTabs:allowedTabs(req.user,null)}); }
  const tabs=allowedTabs(req.user,state); const filtered={};
  for(const key of tableKeys) {
    if(key==='rolePermissions') {
      if (isAdminUser(req.user)) filtered.rolePermissions = state.rolePermissions || {};
      else if (isManagerUser(req.user) && tabs.includes('agents')) {
        // Expose ordinary role names for the Manager's agent-role dropdown,
        // but never expose Admin/Manager permission definitions.
        const visibleRoleNames = Object.keys(state.rolePermissions || {}).filter(role => !isPrivilegedAgentRole(role));
        filtered.rolePermissions = Object.fromEntries(visibleRoleNames.map(role => [role, []]));
        const ownExtras = (state.rolePermissions?.[req.user.role] || []).filter(value =>
          (value.startsWith('export:') && tabs.includes(value.slice(7))) ||
          (value.startsWith('overview:') && tabs.includes('dashboard'))
        );
        filtered.rolePermissions[req.user.role] = [...tabs, ...ownExtras];
      } else {
        const ownExtras = (state.rolePermissions?.[req.user.role] || []).filter(value =>
          (value.startsWith('export:') && tabs.includes(value.slice(7))) ||
          (value.startsWith('overview:') && tabs.includes('dashboard'))
        );
        filtered.rolePermissions = { [req.user.role]: [...tabs, ...ownExtras] };
      }
      continue;
    }
    if(canAccessKey(key,tabs,state,req.user)) filtered[key]=state[key];
    else if(key==='branding') filtered[key]=state[key];
    else filtered[key]=[];
  }
  if(Array.isArray(filtered.agents)) {
    const visible = !isAdminUser(req.user) ? filtered.agents.filter(agent => !isPrivilegedAgentRole(agent.role)) : filtered.agents;
    filtered.agents=visible.map(({password,...agent})=>({...agent,password:''}));
  }
  if(!tabs.includes('agents')) filtered.agents=[];
  if (!isAdminUser(req.user)) {
    const ownVisibility = state.overviewVisibility?.[req.user.username];
    filtered.overviewVisibility = ownVisibility ? { [req.user.username]: ownVisibility } : {};
  }
  res.json({state:filtered,allowedTabs:tabs});
});
app.put('/api/state',auth,async(req,res)=>{
  const incoming=req.body?.state; if(!incoming || typeof incoming!=='object' || Array.isArray(incoming)) return res.status(400).json({error:'Invalid state payload'});
  const existing=await getState(); if(!existing && !isAdminUser(req.user)) return res.status(403).json({error:'Only an administrator can initialize the CRM data store'}); const tabs=allowedTabs(req.user,existing); const next={...(existing||{})};
  for(const key of tableKeys) {
    if (!Object.hasOwn(incoming,key)) continue;
    if (key === 'overviewVisibility' && !isAdminUser(req.user)) {
      const own = incoming.overviewVisibility?.[req.user.username];
      next.overviewVisibility = { ...(existing?.overviewVisibility || {}) };
      if (own === undefined) delete next.overviewVisibility[req.user.username];
      else next.overviewVisibility[req.user.username] = own;
      continue;
    }
    if (canAccessKey(key,tabs,existing,req.user,{write:true})) next[key]=incoming[key];
  }
  // ZITADEL is authoritative for linked identity email addresses. Admins may still
  // change CRM roles/status/profile fields, but cannot silently rewrite the identity email.
  if (Array.isArray(incoming.agents)) {
    // Only rows provisioned in the dedicated agents table (normally by ZITADEL)
    // may exist in the CRM document. Browser payloads cannot create staff accounts.
    const persistedAgents = await pool.query('SELECT agent_id,email,username,zitadel_user_id FROM agents');
    const persistedById = new Map(persistedAgents.rows.map(row => [String(row.agent_id), row]));
    next.agents = (next.agents || []).filter(agent => persistedById.has(String(agent.agent_id))).map(agent => {
      const identity = persistedById.get(String(agent.agent_id));
      return { ...agent, email: identity.email, username: identity.username };
    });
  }
  // Managers may manage ordinary agents only. Keep Admin and Manager accounts
  // out of their response and immutable in the persisted CRM state.
  if (!isAdminUser(req.user) && isManagerUser(req.user) && tabs.includes('agents') && Array.isArray(incoming.agents)) {
    const existingAgents = Array.isArray(existing?.agents) ? existing.agents : [];
    const existingById = new Map(existingAgents.map(agent => [String(agent.agent_id), agent]));
    const incomingById = new Map(incoming.agents.map(agent => [String(agent.agent_id), agent]));
    const merged = existingAgents.map(agent => {
      if (isPrivilegedAgentRole(agent.role)) return agent;
      const submitted = incomingById.get(String(agent.agent_id));
      if (!submitted || !isAssignableRole(submitted.role, existing)) return agent;
      return { ...agent, ...submitted, status: agent.status, agent_id: agent.agent_id };
    });
    next.agents = merged;
  }
  // Stamp newly created history rows using the server-observed client IP.
  // Ignore browser-supplied IPs and retain the original IP for existing rows.
  if (Array.isArray(next.histories)) {
    const oldRows = existing?.histories || [];
    const oldIds = new Set(oldRows.map(row => String(row.history_id)));
    const observedIp = getClientPublicIp(req); // Actual visitor IP forwarded by the trusted edge proxy, or direct peer IP.
    next.histories = next.histories.map(row => {
      if (!oldIds.has(String(row.history_id))) return { ...row, ip_address: observedIp };
      const old = oldRows.find(item => String(item.history_id) === String(row.history_id));
      return { ...row, ip_address: old?.ip_address ?? row.ip_address ?? null };
    });
  }
  // Keep the normalized roles master table synchronized with configured roles.
  if (isAdminUser(req.user) && incoming.rolePermissions && typeof incoming.rolePermissions === 'object') {
    const roleNames = Object.keys(incoming.rolePermissions).map((name) => String(name).trim()).filter(Boolean);
    for (const name of roleNames) {
      await pool.query('INSERT INTO roles(name) VALUES($1) ON CONFLICT(name) DO NOTHING', [name]);
    }
    // Remove any role omitted from the configured role list, except Admin or roles still assigned to an account.
    await pool.query(
      `DELETE FROM roles r WHERE lower(r.name) NOT IN ('admin','manager') AND NOT (r.name = ANY($1::text[]))
       AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.role = r.name)`,
      [roleNames]
    );
  }
  // Server-authoritative financial validation. Orders are recalculated from their saved
  // unit price/discount, and newly created invoices receive immutable pricing snapshots.
  const money = value => Number(Number(value).toFixed(2));
  const marketPriceByName = new Map((next.marketPrices || []).map(item => [String(item.name), item]));
  const normalizedOrders = [];
  for (const order of (next.orders || [])) {
    const market = marketPriceByName.get(String(order.fish_category));
    const quantity = Number(order.quantity);
    const unitPrice = Number(order.price ?? market?.price ?? 0);
    const unit = order.price_unit || market?.unit || 'per piece';
    const discountEnabled = Boolean(order.discount_enabled);
    const subtotal = money(quantity * unitPrice);
    const legacyDiscountAmount = Number(order.discount || 0);
    const discountPercent = order.discount_percent !== undefined && order.discount_percent !== null
      ? Number(order.discount_percent)
      : (discountEnabled && subtotal > 0 ? (legacyDiscountAmount / subtotal) * 100 : 0);
    const discount = discountEnabled ? money(subtotal * discountPercent / 100) : 0;
    if (!Number.isFinite(quantity) || quantity <= 0 || (unit === 'per piece' && !Number.isInteger(quantity)) || !Number.isFinite(unitPrice) || unitPrice < 0 || !['per piece','per kilo'].includes(unit)) {
      return res.status(400).json({error:`Order #${order.order_id || '?'} has invalid quantity or unit pricing.`});
    }
    if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
      return res.status(400).json({error:`Order #${order.order_id || '?'} discount must be between 0% and 100%.`});
    }
    normalizedOrders.push({ ...order, price: unitPrice, price_unit: unit, discount, discount_percent: discountPercent, discount_enabled: discountEnabled, total_price: money(subtotal - discount) });
  }
  next.orders = normalizedOrders;
  for (const followUp of (next.followUpOrders || [])) {
    const unit = marketPriceByName.get(String(followUp.fish_category))?.unit || 'per piece';
    const quantity = Number(followUp.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || (unit === 'per piece' && !Number.isInteger(quantity))) {
      return res.status(400).json({error:`Follow-up #${followUp.follow_up_orders_id || '?'} has an invalid quantity for ${unit}.`});
    }
  }
  const existingInvoicesById = new Map((existing?.invoices || []).map(invoice => [String(invoice.invoice_id), invoice]));
  const normalizedInvoices = [];
  for (const invoice of (next.invoices || [])) {
    const oldInvoice = existingInvoicesById.get(String(invoice.invoice_id));
    if (oldInvoice) {
      const oldFollowUp = (existing?.followUpOrders || []).find(row => Number(row.follow_up_orders_id) === Number(oldInvoice.follow_up_orders_id));
      const wasOrderLinked = Boolean(oldInvoice.order_id ?? oldFollowUp?.order_id);
      if (wasOrderLinked) {
        const financialFields = ['quantity','item_price_per_piece','item_unit','subtotal','discount','discount_enabled','total_price'];
        const changedTerms = financialFields.some(key => Number(oldInvoice[key] ?? 0) !== Number(invoice[key] ?? 0) && oldInvoice[key] !== invoice[key]);
        if (changedTerms) return res.status(409).json({error:`Pricing terms on invoice ${oldInvoice.official_receipt_id} are locked to its originating order. Use an adjustment/credit-note workflow for corrections.`});
      }
      normalizedInvoices.push(invoice);
      continue;
    }
    const followUp = (next.followUpOrders || []).find(row => Number(row.follow_up_orders_id) === Number(invoice.follow_up_orders_id));
    const linkedOrderId = invoice.order_id ?? followUp?.order_id;
    const linkedOrder = linkedOrderId ? next.orders.find(row => Number(row.order_id) === Number(linkedOrderId)) : undefined;
    const market = marketPriceByName.get(String(invoice.fish_category));
    const quantity = Number(linkedOrder?.quantity ?? invoice.quantity);
    const unitPrice = Number(linkedOrder?.price ?? invoice.item_price_per_piece ?? market?.price ?? 0);
    const unit = linkedOrder?.price_unit ?? invoice.item_unit ?? market?.unit ?? 'per piece';
    const discountEnabled = Boolean(linkedOrder ? linkedOrder.discount_enabled : invoice.discount_enabled);
    const discount = discountEnabled ? Number(linkedOrder?.discount ?? invoice.discount ?? 0) : 0;
    const subtotal = money(quantity * unitPrice);
    if (!Number.isFinite(quantity) || quantity <= 0 || (unit === 'per piece' && !Number.isInteger(quantity)) || !Number.isFinite(unitPrice) || unitPrice < 0 || !['per piece','per kilo'].includes(unit)) {
      return res.status(400).json({error:`Invoice ${invoice.official_receipt_id || invoice.invoice_id} has invalid quantity or unit pricing.`});
    }
    if (!Number.isFinite(discount) || discount < 0 || discount > subtotal) {
      return res.status(400).json({error:`Invoice ${invoice.official_receipt_id || invoice.invoice_id} has a discount greater than its subtotal.`});
    }
    const total = money(subtotal - discount);
    const snapshot = { unit_price: unitPrice, unit, quantity, subtotal, discount, discount_enabled: discountEnabled, total, captured_at: new Date().toISOString(), source: linkedOrder ? 'order' : followUp ? 'follow_up' : 'market_price' };
    normalizedInvoices.push({ ...invoice, order_id: invoice.order_id ?? linkedOrder?.order_id, farm_name: linkedOrder?.farm_name ?? invoice.farm_name, contact_person_name: linkedOrder?.contact_person ?? invoice.contact_person_name, fish_category: linkedOrder?.fish_category ?? invoice.fish_category, quantity, item_price_per_piece: unitPrice, item_unit: unit, subtotal, discount, discount_enabled: discountEnabled, total_price: total, pricing_snapshot: snapshot });
  }
  next.invoices = normalizedInvoices;
  // Keep Admin permissions immutable to non-admins.
  if(!isAdminUser(req.user) && existing?.rolePermissions) next.rolePermissions=existing.rolePermissions;
  // Preserve farm/contact links when a farm is renamed.
  if (existing?.farmRegistries && next.farmRegistries && existing?.contactPeople && next.contactPeople) {
    const oldById = new Map(existing.farmRegistries.map(f => [String(f.farm_id), f.farm_name]));
    const renamed = new Map();
    for (const farm of next.farmRegistries) { const oldName=oldById.get(String(farm.farm_id)); if(oldName && oldName!==farm.farm_name) renamed.set(oldName.toLowerCase(),farm.farm_name); }
    if (renamed.size && !isAdminUser(req.user) && !tabs.includes('contact_people')) return res.status(403).json({error:'You also need Contact People permission to rename a farm linked to contacts.'});
    if (renamed.size) next.contactPeople=next.contactPeople.map(c=>({...c,farm_name:renamed.get(String(c.farm_name).toLowerCase())||c.farm_name}));
  }
  const farmNames = new Set((next.farmRegistries||[]).map(f=>String(f.farm_name||'').trim().toLowerCase()));
  const seenContacts = new Set();
  for (const contact of (next.contactPeople||[])) {
    const contactName=String(contact.contact_person_name||'').trim().toLowerCase();
    const farmName=String(contact.farm_name||'').trim().toLowerCase();
    if (!contactName || !farmName || !farmNames.has(farmName)) return res.status(400).json({error:`Contact ${contact.contact_person_name||'(unnamed)'} must be linked to an existing farm.`});
    if (seenContacts.has(contactName)) return res.status(400).json({error:`Contact person name '${contact.contact_person_name}' can only be associated with one farm and must be unique.`});
    seenContacts.add(contactName);
    if (!['yes','no'].includes(contact.is_point_person) || !['yes','no'].includes(contact.is_active)) return res.status(400).json({error:'Invalid contact point-person or active status.'});
  }
  const changedKeys = tableKeys.filter(key => JSON.stringify(existing?.[key] ?? null) !== JSON.stringify(next?.[key] ?? null));
  const recordCounts = Object.fromEntries(['orders','followUpOrders','invoices','deliveries','revenues','opportunities'].map(key => [key,Array.isArray(next[key]) ? next[key].length : 0]));
  const persistClient = await pool.connect();
  try {
    await persistClient.query('BEGIN');
    await persistClient.query(`INSERT INTO crm_state(id,state,updated_at) VALUES(1,$1::jsonb,now()) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()`, [JSON.stringify(next)]);
    await refreshStateRecordMirror(persistClient, next);
    await syncRelationalCollections(persistClient, next);
    await persistClient.query(`INSERT INTO crm_audit_events(actor_agent_id,actor_name,action,entity,changed_keys,record_counts) VALUES($1,$2,'STATE_SYNC','crm_state',$3::jsonb,$4::jsonb)`, [req.user.agent_id,req.user.name,JSON.stringify(changedKeys),JSON.stringify(recordCounts)]);
    await persistClient.query('COMMIT');
  } catch (persistError) { await persistClient.query('ROLLBACK'); throw persistError; }
  finally { persistClient.release(); }
  // Keep account credentials in the dedicated PostgreSQL agents table, not only in the CRM document.
  if ((isAdminUser(req.user) || (isManagerUser(req.user) && tabs.includes('agents'))) && Array.isArray(incoming.agents)) {
    const submittedAgents = isAdminUser(req.user)
      ? incoming.agents
      : incoming.agents.filter(agent => isAssignableRole(agent?.role, existing));
    for (const a of submittedAgents) {
      if (!isAdminUser(req.user)) {
        const protectedAccount = await pool.query('SELECT role FROM agents WHERE agent_id=$1', [a.agent_id]);
        if (protectedAccount.rowCount && isPrivilegedAgentRole(protectedAccount.rows[0].role)) continue;
      }
      // Agent records returned by the API intentionally have blank passwords.
      // Do not skip role/profile updates just because the password is not present.
      if (!a.agent_id || !a.username || !a.name || !a.role) continue;
      const existingAgent = await pool.query(
        'SELECT password,status,email,username,zitadel_user_id FROM agents WHERE agent_id=$1',
        [a.agent_id]
      );
      // Browser state may update existing access assignments, but only ZITADEL
      // provisioning is allowed to create a new CRM agent account.
      if (!existingAgent.rowCount) continue;
      const passwordHash = existingAgent.rows[0].password;
      const identityEmail = existingAgent.rows[0].email;
      const identityUsername = existingAgent.rows[0].username;
      const submittedStatus = isAdminUser(req.user)
        ? (a.status === 'Active' ? 'Active' : 'Inactive')
        : (existingAgent.rowCount ? existingAgent.rows[0].status || 'Inactive' : 'Inactive');
      await pool.query(`INSERT INTO agents(agent_id,name,address,phone,email,status,role,username,password,date_started,avatar_url)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(agent_id) DO UPDATE SET
          name=EXCLUDED.name,
          address=EXCLUDED.address,
          phone=EXCLUDED.phone,
          email=EXCLUDED.email,
          status=EXCLUDED.status,
          role=EXCLUDED.role,
          username=EXCLUDED.username,
          password=CASE WHEN EXCLUDED.password IS NOT NULL AND EXCLUDED.password<>'' THEN EXCLUDED.password ELSE agents.password END,
          date_started=EXCLUDED.date_started,
          avatar_url=COALESCE(EXCLUDED.avatar_url,agents.avatar_url)`,
        [a.agent_id,a.name,a.address||null,a.phone||null,identityEmail,submittedStatus,a.role,identityUsername,passwordHash,a.date_started||new Date().toISOString(),a.avatar_url||null]);
    }
    // Keep BIGSERIAL aligned with the highest sequential ID. Older CRM builds
    // stored Date.now() timestamps as agent IDs; exclude those legacy values.
    await pool.query(`SELECT setval(
      pg_get_serial_sequence('agents', 'agent_id')::regclass,
      GREATEST(COALESCE((SELECT MAX(agent_id) FROM agents WHERE agent_id < 1000000000000), 1), 1),
      true
    )`);
  }
  res.json({ok:true,updated_at:new Date().toISOString()});
});
app.put('/api/me',auth,async(req,res)=>{
  const name=String(req.body?.name||'').trim();
  const phone=String(req.body?.phone||'').trim() || null;
  const address=String(req.body?.address||'').trim() || null;
  const avatarUrl = req.body?.avatar_url == null ? undefined : String(req.body.avatar_url);
  if(!name) return res.status(400).json({error:'Full name is required.'});
  const {rows}=await pool.query('SELECT zitadel_user_id,avatar_url FROM agents WHERE agent_id=$1',[req.user.agent_id]);
  if(!rows[0]) return res.status(404).json({error:'Account not found.'});
  if (avatarUrl !== undefined && avatarUrl) {
    const isUploadedImage = /^data:image\/(png|jpeg|webp|gif);base64,/.test(avatarUrl) && avatarUrl.length <= 2800000;
    let isExistingZitadelPicture = false;
    if (rows[0].zitadel_user_id && avatarUrl === rows[0].avatar_url) {
      try { const parsed = new URL(avatarUrl); isExistingZitadelPicture = parsed.protocol === 'https:' && avatarUrl.length <= 2048; } catch { /* Not a URL. */ }
    }
    if (!isUploadedImage && !isExistingZitadelPicture) return res.status(400).json({error:'Avatar must be an uploaded PNG, JPEG, WEBP or GIF image under 2 MB, or your existing ZITADEL profile picture.'});
  }
  const updated=await pool.query(`UPDATE agents SET name=$1,phone=$2,address=$3,avatar_url=COALESCE($4,avatar_url)
    WHERE agent_id=$5 RETURNING agent_id,name,address,phone,email,status,role,username,date_started,avatar_url,zitadel_user_id`,
    [name,phone,address,avatarUrl,req.user.agent_id]);
  const user={...updated.rows[0],auth_provider:updated.rows[0].zitadel_user_id?'zitadel':'local'};
  delete user.zitadel_user_id;
  const state=await getState();
  if(state && Array.isArray(state.agents)) {
    state.agents=state.agents.map(a=>Number(a.agent_id)===Number(user.agent_id)?{...a,...user}:a);
    await pool.query('UPDATE crm_state SET state=$1::jsonb,updated_at=now() WHERE id=1',[JSON.stringify(state)]);
  }
  res.json({user});
});
app.get('/api/online-inquiries',auth,requireTabPermission('online_inquiry'),async(req,res)=>{ const r=await pool.query('SELECT inquiry_id,inquiry_datetime,source,customer_name,phone,email,message,status FROM online_inquiry ORDER BY inquiry_datetime DESC'); res.json({items:r.rows}); });
app.post('/api/online-inquiries',auth,requireTabPermission('online_inquiry'),async(req,res)=>{ const b=req.body||{}; if(!String(b.customer_name||'').trim() || !String(b.source||'').trim()) return res.status(400).json({error:'Customer name and source are required'}); const r=await pool.query('INSERT INTO online_inquiry(source,customer_name,phone,email,message,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[b.source,String(b.customer_name).trim(),b.phone||null,b.email||null,b.message||null,b.status==='processed'?'processed':'unread']); res.status(201).json({item:r.rows[0]}); });
app.patch('/api/online-inquiries/:id',auth,requireTabPermission('online_inquiry'),async(req,res)=>{ const r=await pool.query("UPDATE online_inquiry SET status=$1 WHERE inquiry_id=$2 RETURNING *",[req.body?.status==='processed'?'processed':'unread',Number(req.params.id)]); if(!r.rowCount)return res.status(404).json({error:'Inquiry not found'}); res.json({item:r.rows[0]}); });
app.get('/api/online-inquiry-sources',auth,async(req,res)=>{
  if(!isAdminUser(req.user)) return res.status(403).json({error:'Administrator access required'});
  const r=await pool.query(`SELECT s.source_id,s.source_name,COUNT(i.inquiry_id)::int AS inquiry_count
    FROM online_inquiry_sources s LEFT JOIN online_inquiry i ON i.source=s.source_name
    GROUP BY s.source_id,s.source_name ORDER BY s.source_name`);
  res.json({items:r.rows});
});
app.post('/api/online-inquiry-sources',auth,async(req,res)=>{
  if(!isAdminUser(req.user)) return res.status(403).json({error:'Administrator access required'});
  const name=String(req.body?.source_name||'').trim();
  if(!name)return res.status(400).json({error:'Source name is required'});
  if(name.length>100)return res.status(400).json({error:'Source name must be 100 characters or fewer'});
  try {
    const r=await pool.query('INSERT INTO online_inquiry_sources(source_name) VALUES($1) RETURNING source_id,source_name',[name]);
    res.status(201).json({item:{...r.rows[0],inquiry_count:0}});
  } catch(e){ if(e.code==='23505')return res.status(409).json({error:'Source already exists'}); throw e; }
});
app.patch('/api/online-inquiry-sources/:id',auth,async(req,res)=>{
  if(!isAdminUser(req.user)) return res.status(403).json({error:'Administrator access required'});
  const id=Number(req.params.id), name=String(req.body?.source_name||'').trim();
  if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:'Invalid source ID'});
  if(!name)return res.status(400).json({error:'Source name is required'});
  if(name.length>100)return res.status(400).json({error:'Source name must be 100 characters or fewer'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const current=await client.query('SELECT source_id,source_name FROM online_inquiry_sources WHERE source_id=$1 FOR UPDATE',[id]);
    if(!current.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Inquiry source not found'});}
    const oldName=current.rows[0].source_name;
    if(oldName===name){
      const count=await client.query('SELECT COUNT(*)::int AS inquiry_count FROM online_inquiry WHERE source=$1',[oldName]);
      await client.query('COMMIT');
      return res.json({item:{...current.rows[0],inquiry_count:count.rows[0].inquiry_count}});
    }
    // The inquiry table references source_name, so create the replacement first,
    // move existing inquiries, then remove the old lookup row in one transaction.
    const replacement=await client.query('INSERT INTO online_inquiry_sources(source_name) VALUES($1) RETURNING source_id,source_name',[name]);
    await client.query('UPDATE online_inquiry SET source=$1 WHERE source=$2',[name,oldName]);
    await client.query('DELETE FROM online_inquiry_sources WHERE source_id=$1',[id]);
    await client.query('COMMIT');
    res.json({item:{...replacement.rows[0],inquiry_count:0}});
  } catch(e){
    await client.query('ROLLBACK');
    if(e.code==='23505')return res.status(409).json({error:'Another inquiry source already uses that name'});
    throw e;
  } finally { client.release(); }
});
app.delete('/api/online-inquiry-sources/:id',auth,async(req,res)=>{
  if(!isAdminUser(req.user)) return res.status(403).json({error:'Administrator access required'});
  const id=Number(req.params.id);
  if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:'Invalid source ID'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const source=await client.query('SELECT source_id,source_name FROM online_inquiry_sources WHERE source_id=$1 FOR UPDATE',[id]);
    if(!source.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Inquiry source not found'});}
    const usage=await client.query('SELECT COUNT(*)::int AS inquiry_count FROM online_inquiry WHERE source=$1',[source.rows[0].source_name]);
    if(usage.rows[0].inquiry_count>0){
      await client.query('ROLLBACK');
      return res.status(409).json({error:`This source is used by ${usage.rows[0].inquiry_count} existing ${usage.rows[0].inquiry_count===1?'inquiry':'inquiries'}. Edit the source name to preserve those records, or remove/reassign the inquiries first.`,inquiry_count:usage.rows[0].inquiry_count});
    }
    await client.query('DELETE FROM online_inquiry_sources WHERE source_id=$1',[id]);
    await client.query('COMMIT');
    res.json({success:true});
  } catch(e){ await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
});
app.get('/api/admin/truncate-eligibility',auth,async(req,res)=>{
  if(!isAdminUser(req.user)) return res.status(403).json({error:'Administrator access required.'});
  const result=await pool.query(`SELECT GREATEST(0,CEIL(300-EXTRACT(EPOCH FROM (now()-MAX(downloaded_at))))::int) AS remaining_seconds FROM crm_backup_exports WHERE admin_agent_id=$1 AND downloaded_at IS NOT NULL AND consumed_at IS NULL AND downloaded_at > now()-interval '5 minutes'`,[req.user.agent_id]);
  const remainingSeconds=Number(result.rows[0]?.remaining_seconds||0);
  res.json({eligible:remainingSeconds>0,remainingSeconds});
});
app.post('/api/admin/confirm-backup-export',auth,async(req,res)=>{
  if(!isAdminUser(req.user)) return res.status(403).json({error:'Administrator access required.'});
  const exportId=String(req.body?.exportId||'');
  if(!/^[0-9a-f-]{36}$/i.test(exportId)) return res.status(400).json({error:'Invalid backup export reference.'});
  const result=await pool.query(`UPDATE crm_backup_exports SET downloaded_at=now() WHERE export_id=$1 AND admin_agent_id=$2 AND downloaded_at IS NULL AND consumed_at IS NULL RETURNING export_id`,[exportId,req.user.agent_id]);
  if(!result.rowCount) return res.status(409).json({error:'Backup export could not be confirmed. Export the CRM data again.'});
  res.json({ok:true});
});
app.post('/api/admin/clear-operational-data',auth,async(req,res)=>{
  if(!isAdminUser(req.user)) return res.status(403).json({error:'Administrator access required.'});
  if(req.body?.confirmation!=='CLEAR CRM DATA') return res.status(400).json({error:'Confirmation phrase did not match.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const backup=await client.query(`SELECT export_id FROM crm_backup_exports WHERE admin_agent_id=$1 AND downloaded_at IS NOT NULL AND consumed_at IS NULL AND downloaded_at > now()-interval '5 minutes' ORDER BY downloaded_at DESC LIMIT 1 FOR UPDATE`,[req.user.agent_id]);
    if(!backup.rowCount){await client.query('ROLLBACK');return res.status(409).json({error:'Export CRM Data (.SQL) successfully before truncating operational data.'});}
    const result=await client.query('SELECT state FROM crm_state WHERE id=1 FOR UPDATE');
    const state=result.rows[0]?.state || {};
    // Keep agent accounts, role-to-table restrictions, branding and workflow lookup lists.
    // Clear operational records and market pricing master data to provide a genuinely clean workspace.
    for(const key of ['marketPrices','farmRegistries','contactPeople','opportunities','orders','followUpOrders','invoices','deliveries','revenues','histories']) state[key]=[];
    state.overviewVisibility={};
    await client.query('INSERT INTO crm_state(id,state,updated_at) VALUES(1,$1::jsonb,now()) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()',[JSON.stringify(state)]);
    await refreshStateRecordMirror(client,state);
    await syncRelationalCollections(client,state);
    await client.query(`INSERT INTO crm_audit_events(actor_agent_id,actor_name,action,entity,changed_keys,record_counts)
      VALUES($1,$2,'CLEAR_OPERATIONAL_DATA','crm_state',$3::jsonb,$4::jsonb)`,
      [req.user.agent_id,req.user.name,JSON.stringify(['marketPrices','farmRegistries','contactPeople','opportunities','orders','followUpOrders','invoices','deliveries','revenues','histories']),JSON.stringify({orders:0,invoices:0,deliveries:0,revenues:0})]);
    await client.query('UPDATE crm_backup_exports SET consumed_at=now() WHERE export_id=$1',[backup.rows[0].export_id]);
    await client.query('COMMIT');
    res.json({ok:true,message:'CRM tables cleared. Agent accounts, role restrictions and essential application configuration were preserved.'});
  } catch(error) {
    await client.query('ROLLBACK');
    console.error('CRM data clear failed:',error);
    res.status(500).json({error:'Unable to clear CRM data.'});
  } finally { client.release(); }
});
app.post('/api/auth/logout',auth,async(req,res)=>{
  try {
    const payload=JSON.parse(Buffer.from(req.token.split('.')[0],'base64url').toString());
    const session=await pool.query('SELECT id_token FROM crm_sessions WHERE token_id=$1',[payload.jti]);
    await pool.query('DELETE FROM crm_sessions WHERE token_id=$1',[payload.jti]);
    res.setHeader('Set-Cookie', `crm_session=; ${cookieOptions(0)}`);
    let logoutUrl = null;
    if (session.rows[0]?.id_token) {
      const metadata = await getOidcMetadata();
      if (metadata.end_session_endpoint) {
        const url = new URL(metadata.end_session_endpoint);
        url.searchParams.set('id_token_hint', session.rows[0].id_token);
        url.searchParams.set('post_logout_redirect_uri', process.env.ZITADEL_POST_LOGOUT_URI || process.env.CRM_PUBLIC_URL || 'https://crm.mesina.farm');
        url.searchParams.set('client_id', process.env.ZITADEL_CLIENT_ID);
        // Preserve the registered redirect URI and use OIDC state to show the
        // signed-out page rather than automatically starting another login.
        url.searchParams.set('state', 'crm_logged_out');
        logoutUrl = url.toString();
      }
    }
    res.json({ok:true,logoutUrl});
  } catch (error) { console.error('Logout failed:',error.message); res.json({ok:true,logoutUrl:null}); }
});

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const dist=path.join(__dirname,'dist');
app.use(express.static(dist,{index:false, maxAge:'1h'}));
app.get('*',(req,res)=>{ if(req.path.startsWith('/api/')) return res.status(404).json({error:'Not found'}); res.sendFile(path.join(dist,'index.html')); });
init().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`Mesina Farms CRM v2.08.9 listening on ${port}`))).catch(err=>{console.error('Startup failed:',err);process.exit(1)});
