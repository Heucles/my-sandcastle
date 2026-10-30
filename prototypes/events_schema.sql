-- Migration: 0001_create_events_table.sql
-- Purpose: Replaces the legacy MongoDB `events` audit-trail collection.

CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(255) NOT NULL,
  event_content JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Indices for auditing and debugging (e.g. "show me all events of type X" or "show me what happened on date Y")
CREATE INDEX idx_events_event_type ON events(event_type);
CREATE INDEX idx_events_created_at ON events(created_at);
