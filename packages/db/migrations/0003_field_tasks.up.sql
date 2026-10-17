-- Field work: tasks assigned to team members, and the field-worker role that does them.

INSERT INTO roles (name, description) VALUES
  ('worker', 'Do assigned field tasks, record observations and upload photos')
ON CONFLICT (name) DO NOTHING;

CREATE TABLE farm_tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  farm_id               uuid NOT NULL,
  title                 text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  kind                  text NOT NULL CHECK (kind IN ('irrigation', 'fertilizing', 'spraying', 'planting', 'weeding', 'pruning', 'harvest', 'scouting', 'maintenance', 'other')),
  parcel_label          text CHECK (length(parcel_label) <= 80),
  assignee_user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  -- A calendar day in the farm's time zone, not an instant.
  due_date              date NOT NULL,
  priority              text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status                text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done', 'cancelled')),
  notes                 text CHECK (length(notes) <= 4000),
  repeat_every_days     integer CHECK (repeat_every_days BETWEEN 1 AND 365),
  -- The task this one was repeated from; unique so completing twice can never create two follow-ups.
  previous_task_id      uuid UNIQUE REFERENCES farm_tasks(id) ON DELETE SET NULL,
  completion_note       text CHECK (length(completion_note) <= 4000),
  completion_media_ids  uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(completion_media_ids) <= 10),
  completed_at          timestamptz,
  completed_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, farm_id) REFERENCES farms(tenant_id, id) ON DELETE CASCADE,
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
);
CREATE INDEX farm_tasks_farm_idx ON farm_tasks(tenant_id, farm_id, status, due_date);
CREATE INDEX farm_tasks_assignee_idx ON farm_tasks(tenant_id, assignee_user_id, status, due_date);
CREATE INDEX farm_tasks_due_idx ON farm_tasks(tenant_id, due_date);

ALTER TABLE farm_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE farm_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON farm_tasks TO metafarm_app
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY owner_bypass ON farm_tasks TO CURRENT_USER USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON farm_tasks TO metafarm_app;
