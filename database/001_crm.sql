BEGIN;
CREATE SCHEMA crm;
CREATE TABLE crm.migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE crm.tenants (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE crm.teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL REFERENCES crm.tenants(id),
  name varchar(100) NOT NULL CHECK (length(btrim(name)) > 0), enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id)
);
CREATE TABLE crm.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL REFERENCES crm.tenants(id),
  team_id uuid, username varchar(100) NOT NULL CHECK (length(btrim(username)) > 0),
  display_name varchar(100) NOT NULL CHECK (length(btrim(display_name)) > 0),
  role text NOT NULL CHECK (role IN ('sales','manager','admin')),
  password_hash text NOT NULL, enabled boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true, session_version integer NOT NULL DEFAULT 1 CHECK (session_version > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,team_id) REFERENCES crm.teams(tenant_id,id),
  CHECK (role = 'admin' OR team_id IS NOT NULL)
);
CREATE UNIQUE INDEX users_login_idx ON crm.users (tenant_id,lower(username));
CREATE TABLE crm.sessions (
  token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32), tenant_id text NOT NULL, user_id uuid NOT NULL,
  session_version integer NOT NULL CHECK (session_version > 0), csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  revoked_at timestamptz, FOREIGN KEY (tenant_id,user_id) REFERENCES crm.users(tenant_id,id),
  CHECK (expires_at > created_at), CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX sessions_user_idx ON crm.sessions (tenant_id,user_id);
CREATE TABLE crm.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, owner_id uuid NOT NULL,
  name varchar(200) NOT NULL CHECK (length(btrim(name)) > 0), contact varchar(100) NOT NULL DEFAULT '',
  phone varchar(11) NOT NULL CHECK (phone ~ '^1[3-9][0-9]{9}$'), alt_phone varchar(50) NOT NULL DEFAULT '',
  wechat varchar(100) NOT NULL DEFAULT '', email varchar(254) NOT NULL DEFAULT '',
  source text NOT NULL CHECK (source IN ('call','visit','friend_referral','customer_referral','xiaohongshu','douyin','other_online')),
  status text NOT NULL DEFAULT 'added' CHECK (status IN ('added','opened','shipped')),
  address varchar(500) NOT NULL DEFAULT '', needs varchar(2000) NOT NULL DEFAULT '',
  note varchar(4000) NOT NULL DEFAULT '', high_intent boolean NOT NULL DEFAULT false,
  last_follow_at timestamptz, next_follow_at timestamptz, archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,id), FOREIGN KEY (tenant_id,owner_id) REFERENCES crm.users(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES crm.users(tenant_id,id)
);
CREATE TABLE crm.follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, customer_id uuid NOT NULL,
  actor_id uuid NOT NULL, action text NOT NULL CHECK (action IN ('greeting','quote','inquiry','order')),
  content varchar(4000) NOT NULL CHECK (length(btrim(content)) > 0),
  occurred_at timestamptz NOT NULL DEFAULT now(), next_follow_at timestamptz,
  reminder_action text NOT NULL CHECK (reminder_action IN ('unchanged','set','clear')),
  CHECK ((reminder_action = 'set' AND next_follow_at IS NOT NULL)
    OR (reminder_action IN ('unchanged','clear') AND next_follow_at IS NULL)),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,customer_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES crm.customers(tenant_id,id),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES crm.users(tenant_id,id)
);
CREATE TABLE crm.activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, owner_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('call','visit')),
  customer_name varchar(200) NOT NULL CHECK (length(btrim(customer_name)) > 0),
  phone varchar(11) NOT NULL DEFAULT '', address varchar(500) NOT NULL DEFAULT '', result text NOT NULL,
  next_judge text NOT NULL CHECK (next_judge IN ('revisit','defer','reject')),
  note varchar(4000) NOT NULL DEFAULT '', occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  converted_customer_id uuid, converted_at timestamptz, converted_by uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), UNIQUE (tenant_id,id),
  FOREIGN KEY (tenant_id,owner_id) REFERENCES crm.users(tenant_id,id),
  FOREIGN KEY (tenant_id,converted_customer_id) REFERENCES crm.customers(tenant_id,id),
  FOREIGN KEY (tenant_id,converted_by) REFERENCES crm.users(tenant_id,id),
  CHECK (phone = '' OR phone ~ '^1[3-9][0-9]{9}$'),
  CHECK ((type = 'call' AND phone <> '' AND address = '') OR (type = 'visit' AND length(btrim(address)) > 0)),
  CHECK ((type = 'call' AND result IN ('unanswered','invalid_number','call_rejected','call_deferred','call_interested','contact_added'))
    OR (type = 'visit' AND result IN ('no_entry','visit_rejected','visit_deferred','visit_interested','contact_added'))),
  CHECK ((converted_customer_id IS NULL AND converted_at IS NULL AND converted_by IS NULL)
    OR (converted_customer_id IS NOT NULL AND converted_at IS NOT NULL AND converted_by IS NOT NULL AND result = 'contact_added')),
  CHECK (converted_at IS NULL OR converted_at >= created_at)
);
CREATE TABLE crm.customer_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, customer_id uuid NOT NULL,
  from_status text NOT NULL CHECK (from_status IN ('added','opened','shipped')),
  to_status text NOT NULL CHECK (to_status IN ('added','opened','shipped')), actor_id uuid NOT NULL,
  reason varchar(500), follow_up_id uuid, at timestamptz NOT NULL DEFAULT now(),
  CHECK ((from_status,to_status) IN (('added','opened'),('opened','shipped'),('opened','added'),('shipped','opened'),('shipped','added'))),
  CHECK ((from_status,to_status) IN (('added','opened'),('opened','shipped'))
    OR (reason IS NOT NULL AND length(btrim(reason)) > 0)),
  CHECK (follow_up_id IS NULL OR (from_status,to_status) IN (('added','opened'),('opened','shipped'))),
  FOREIGN KEY (tenant_id,customer_id,follow_up_id) REFERENCES crm.follow_ups(tenant_id,customer_id,id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES crm.customers(tenant_id,id),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES crm.users(tenant_id,id)
);
CREATE TABLE crm.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL REFERENCES crm.tenants(id), actor_id uuid,
  entity_type text NOT NULL, entity_id uuid, action text NOT NULL, request_id text NOT NULL,
  reason varchar(500), changes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(changes) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,actor_id) REFERENCES crm.users(tenant_id,id)
);
CREATE TABLE crm.idempotency_keys (
  tenant_id text NOT NULL, user_id uuid NOT NULL,
  request_target varchar(300) NOT NULL CHECK (length(btrim(request_target)) > 0), key uuid NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  state text NOT NULL DEFAULT 'processing' CHECK (state IN ('processing','completed')),
  response_status integer, response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,user_id,request_target,key), CHECK (expires_at > created_at),
  CHECK ((state = 'processing' AND response_status IS NULL AND response_body IS NULL)
    OR (state = 'completed' AND response_status IS NOT NULL AND response_status BETWEEN 200 AND 299 AND response_body IS NOT NULL)),
  FOREIGN KEY (tenant_id,user_id) REFERENCES crm.users(tenant_id,id)
);
CREATE INDEX users_team_idx ON crm.users (tenant_id,team_id,id);
CREATE INDEX customers_owner_follow_idx ON crm.customers (tenant_id,owner_id,last_follow_at DESC NULLS LAST,id DESC) WHERE archived_at IS NULL;
CREATE INDEX customers_company_follow_idx ON crm.customers (tenant_id,last_follow_at DESC NULLS LAST,id DESC) WHERE archived_at IS NULL;
CREATE INDEX customers_reminder_idx ON crm.customers (tenant_id,owner_id,next_follow_at,id) WHERE archived_at IS NULL AND next_follow_at IS NOT NULL;
CREATE INDEX customers_phone_idx ON crm.customers (tenant_id,phone);
CREATE INDEX follow_ups_customer_idx ON crm.follow_ups (tenant_id,customer_id,occurred_at DESC,id);
CREATE INDEX activities_owner_time_idx ON crm.activities (tenant_id,owner_id,occurred_at DESC,id);
CREATE INDEX activities_company_time_idx ON crm.activities (tenant_id,occurred_at DESC,id DESC);
CREATE INDEX status_events_customer_idx ON crm.customer_status_events (tenant_id,customer_id,at DESC,id DESC);
CREATE INDEX audit_tenant_time_idx ON crm.audit_logs (tenant_id,created_at DESC,id);
CREATE INDEX sessions_expiry_idx ON crm.sessions (expires_at);
CREATE INDEX idempotency_expiry_idx ON crm.idempotency_keys (expires_at);
INSERT INTO crm.migrations(version) VALUES (1);
COMMIT;
