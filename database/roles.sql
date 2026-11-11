-- Run explicitly as database owner, only inside the dedicated sales database.
DO $$ BEGIN
  IF current_database() !~ '^sales_workbench($|_)' THEN
    RAISE EXCEPTION 'Refusing permissions outside a dedicated sales_workbench database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sales_workbench_api') THEN
    CREATE ROLE sales_workbench_api LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sales_workbench_maintenance') THEN
    CREATE ROLE sales_workbench_maintenance NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO sales_workbench_api, sales_workbench_maintenance', current_database());
END $$;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA crm FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA crm FROM PUBLIC, sales_workbench_api, sales_workbench_maintenance;
GRANT USAGE ON SCHEMA crm TO sales_workbench_api, sales_workbench_maintenance;
GRANT SELECT ON ALL TABLES IN SCHEMA crm TO sales_workbench_api;
GRANT INSERT, UPDATE ON crm.customers, crm.activities, crm.users, crm.teams, crm.sessions, crm.idempotency_keys TO sales_workbench_api;
GRANT INSERT ON crm.follow_ups, crm.customer_status_events, crm.audit_logs TO sales_workbench_api;
GRANT SELECT, DELETE ON crm.sessions, crm.idempotency_keys TO sales_workbench_maintenance;
-- Runtime credentials are provisioned separately through a protected file.
-- Also restrict this NEW login to sales_workbench with pg_hba rules before any
-- broad existing rule. PUBLIC CONNECT in other databases is not a permission boundary.
