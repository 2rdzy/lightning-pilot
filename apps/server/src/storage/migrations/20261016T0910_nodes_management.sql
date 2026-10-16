ALTER TABLE nodes ADD COLUMN removed_at TEXT;
ALTER TABLE nodes ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN access_level TEXT NOT NULL DEFAULT 'standard' CHECK (access_level IN ('read-only', 'standard', 'full', 'admin'));
ALTER TABLE nodes ADD COLUMN spend_state TEXT NOT NULL DEFAULT 'missing' CHECK (spend_state IN ('ok', 'revoked', 'missing'));
UPDATE nodes SET access_level = 'read-only' WHERE NOT EXISTS (SELECT 1 FROM credentials WHERE node_id = nodes.id AND kind = 'spend');
-- Old credentials have not passed admission yet. They must be explicitly checked or replaced before spending is enabled.
ALTER TABLE nodes ADD COLUMN credentials_checked_at TEXT;
ALTER TABLE nodes ADD COLUMN view_methods TEXT NOT NULL DEFAULT '[]';
ALTER TABLE nodes ADD COLUMN spend_methods TEXT NOT NULL DEFAULT '[]';
