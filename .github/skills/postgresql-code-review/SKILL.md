---
name: postgresql-code-review
description: 'PostgreSQL-focused code review skill that catches database anti-patterns, performance issues, and security vulnerabilities specific to PostgreSQL. Use when reviewing SQL queries, Prisma schemas, database migrations, stored procedures, triggers, or any code interacting with PostgreSQL. Covers JSONB misuse, array operations, schema design (CITEXT, TIMESTAMPTZ, BIGSERIAL), custom types/domains, function/trigger issues, extension usage, Row-Level Security, and query optimization.'
---

# PostgreSQL Code Review

A specialized code review skill focused on PostgreSQL-specific anti-patterns, performance
issues, and security vulnerabilities. Designed for developers working with PostgreSQL
directly or through ORMs like Prisma, Sequelize, TypeORM, or Django.

## When to Use This Skill

Activate when reviewing:
- SQL queries (raw or ORM-generated)
- Database schema definitions or migrations
- Prisma schema files (`.prisma`)
- Stored procedures, functions, or triggers
- Database indexes and constraints
- Row-Level Security (RLS) policies
- Any code that interacts with PostgreSQL

## Review Checklist

### 1. JSONB Best Practices

**Anti-patterns to flag:**
```sql
-- Storing large amounts of data that should be relational
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  data JSONB NOT NULL  -- If 'data' has consistent structure, normalize it
);

-- Using JSONB for frequently queried fields without indexes
SELECT * FROM events WHERE data->>'status' = 'active';
-- MISSING: CREATE INDEX idx_events_status ON events USING gin ((data->>'status'));

-- Deep nesting in JSONB (> 3 levels deep = code smell)
SELECT data->'level1'->'level2'->'level3'->'level4' FROM events;

-- Using JSONB operators without COALESCE for optional fields
SELECT data->>'name' FROM events;  -- Returns NULL if key missing
```

**Good patterns:**
```sql
-- GIN index for containment queries
CREATE INDEX idx_events_data ON events USING gin (data);
SELECT * FROM events WHERE data @> '{"status": "active"}';

-- Partial JSONB index for common filters
CREATE INDEX idx_active_events ON events USING btree ((data->>'status'))
  WHERE data->>'status' IS NOT NULL;

-- Using jsonb_build_object for safe construction
INSERT INTO events (data) VALUES (jsonb_build_object('key', $1, 'value', $2));
```

---

### 2. Array Operations

**Anti-patterns to flag:**
```sql
-- Storing references in arrays instead of junction tables
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  role_ids INTEGER[]  -- Should be a user_roles junction table
);

-- Querying arrays without GIN index
SELECT * FROM users WHERE 'admin' = ANY(roles);
-- MISSING: CREATE INDEX idx_users_roles ON users USING gin (roles);

-- Large arrays (> 100 elements) in a column
-- Arrays should not be used as unbounded collections
```

**Good patterns:**
```sql
-- GIN index for array containment
CREATE INDEX idx_tags ON articles USING gin (tags);
SELECT * FROM articles WHERE tags @> ARRAY['postgresql']::text[];

-- Small fixed-size arrays (e.g., coordinates, RGB values)
CREATE TABLE locations (
  id SERIAL PRIMARY KEY,
  coords NUMERIC(10,6)[]  -- Always [lat, lng], bounded size
);
```

---

### 3. Schema Design

**Anti-patterns to flag:**
```sql
-- Using VARCHAR without length (equivalent to TEXT but misleading)
CREATE TABLE users (name VARCHAR);  -- Use TEXT instead

-- Using CHAR(n) (space-padded, rarely needed)
CREATE TABLE codes (code CHAR(10));  -- Use TEXT or VARCHAR(10) with CHECK

-- Using TIMESTAMP without timezone
CREATE TABLE events (
  created_at TIMESTAMP  -- Use TIMESTAMPTZ instead
);

-- Using SERIAL instead of BIGSERIAL for primary keys
CREATE TABLE orders (id SERIAL PRIMARY KEY);  -- Use BIGSERIAL for large tables

-- Missing NOT NULL on columns that should never be null
CREATE TABLE users (
  email TEXT,  -- Should be TEXT NOT NULL
  name TEXT    -- Should be TEXT NOT NULL
);

-- Case-sensitive text comparisons when case-insensitive needed
SELECT * FROM users WHERE email = $1;  -- Use CITEXT or lower(email)
```

**Good patterns:**
```sql
-- TIMESTAMPTZ for all timestamp columns
CREATE TABLE events (
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- CITEXT for case-insensitive fields
CREATE EXTENSION IF NOT EXISTS citext;
CREATE TABLE users (
  email CITEXT NOT NULL UNIQUE
);

-- BIGSERIAL for primary keys on high-volume tables
CREATE TABLE order_items (
  id BIGSERIAL PRIMARY KEY
);

-- CHECK constraints for data validation
CREATE TABLE products (
  price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);
```

---

### 4. Custom Types and Domains

**Anti-patterns to flag:**
```sql
-- Using raw TEXT for constrained values without validation
CREATE TABLE orders (status TEXT);  -- Should use ENUM or CHECK

-- Overusing ENUMs (hard to modify)
CREATE TYPE order_status AS ENUM ('pending', 'paid');
-- Adding new values later requires: ALTER TYPE ... ADD VALUE
-- Cannot remove values without table recreation

-- Using NUMERIC without precision for money
CREATE TABLE invoices (amount NUMERIC);  -- Use NUMERIC(12,2) or BIGINT cents
```

**Good patterns:**
```sql
-- Domains for reusable constraints
CREATE DOMAIN positive_cents AS BIGINT CHECK (VALUE >= 0);
CREATE TABLE orders (
  total positive_cents NOT NULL
);

-- TEXT with CHECK for flexible enums
CREATE TABLE orders (
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled'))
);
```

---

### 5. Functions and Triggers

**Anti-patterns to flag:**
```sql
-- Trigger that performs expensive operations on every row
CREATE TRIGGER audit_trigger
  AFTER INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION audit_log();
-- If table has bulk inserts, use FOR EACH STATEMENT instead

-- Function using SECURITY DEFINER without search_path
CREATE FUNCTION admin_action() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
-- MISSING: SET search_path = public (prevents search_path injection)

-- Recursive triggers without depth limit
CREATE TRIGGER cascade_update
  AFTER UPDATE ON parent
  FOR EACH ROW EXECUTE FUNCTION update_children();
-- update_children() updates parent → infinite recursion
```

**Good patterns:**
```sql
-- SECURITY DEFINER with explicit search_path
CREATE FUNCTION safe_admin_action() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  -- function body
END;
$$;

-- Statement-level triggers for batch operations
CREATE TRIGGER batch_audit
  AFTER INSERT ON imports
  FOR EACH STATEMENT EXECUTE FUNCTION log_import_batch();
```

---

### 6. Extensions

**Review for:**
- Are necessary extensions created? (`CREATE EXTENSION IF NOT EXISTS`)
- Are extensions installed in the correct schema?
- Version pinning for reproducibility

**Commonly needed extensions:**
```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";    -- UUID generation
CREATE EXTENSION IF NOT EXISTS "citext";        -- Case-insensitive text
CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- Cryptographic functions
CREATE EXTENSION IF NOT EXISTS "pg_trgm";       -- Trigram similarity search
CREATE EXTENSION IF NOT EXISTS "btree_gin";     -- GIN for scalar types
CREATE EXTENSION IF NOT EXISTS "postgis";       -- Geospatial data
```

---

### 7. Row-Level Security (RLS)

**Anti-patterns to flag:**
```sql
-- RLS enabled but no policies defined (blocks ALL access)
ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;
-- MISSING: CREATE POLICY ... ON secrets

-- Overly permissive policy
CREATE POLICY all_access ON data FOR ALL USING (true);

-- Missing policy for specific operations
CREATE POLICY select_own ON documents FOR SELECT USING (owner_id = current_user_id());
-- MISSING: policies for INSERT, UPDATE, DELETE

-- Force RLS on table owner (often forgotten)
ALTER TABLE sensitive_data FORCE ROW LEVEL SECURITY;
```

**Good patterns:**
```sql
-- Comprehensive RLS with per-operation policies
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

CREATE POLICY documents_select ON documents
  FOR SELECT USING (org_id = current_setting('app.org_id')::uuid);

CREATE POLICY documents_insert ON documents
  FOR INSERT WITH CHECK (org_id = current_setting('app.org_id')::uuid);

CREATE POLICY documents_update ON documents
  FOR UPDATE USING (org_id = current_setting('app.org_id')::uuid);

CREATE POLICY documents_delete ON documents
  FOR DELETE USING (org_id = current_setting('app.org_id')::uuid);
```

---

### 8. Quality Checklist

Run through this for every PostgreSQL review:

- [ ] All timestamp columns use `TIMESTAMPTZ`
- [ ] Primary keys use `BIGSERIAL` or `UUID` (not `SERIAL` for large tables)
- [ ] `NOT NULL` constraints on columns that should never be null
- [ ] Appropriate indexes exist for WHERE clauses, JOINs, and ORDER BY
- [ ] JSONB columns have GIN indexes if queried with containment operators
- [ ] No raw string interpolation in SQL queries (parameterize everything)
- [ ] Money/financial values stored as `BIGINT` cents or `NUMERIC(precision, scale)`
- [ ] Foreign keys have `ON DELETE` behavior defined (CASCADE, SET NULL, RESTRICT)
- [ ] Migrations are reversible (has both up and down)
- [ ] No unnecessary `SELECT *` — specify columns
- [ ] EXPLAIN ANALYZE checked for complex queries
- [ ] Connection pooling configured (PgBouncer, Prisma connection pool)
- [ ] Transactions used for multi-statement mutations
- [ ] Advisory locks or `FOR UPDATE` used for concurrent access patterns
