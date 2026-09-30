ALTER TABLE dramas ADD COLUMN default_video_selection TEXT;
ALTER TABLE episodes ADD COLUMN video_selection TEXT;
ALTER TABLE storyboards ADD COLUMN video_provider TEXT;
ALTER TABLE storyboards ADD COLUMN video_model TEXT;
ALTER TABLE storyboards ADD COLUMN video_config_id INTEGER;
ALTER TABLE storyboards ADD COLUMN shot_intent TEXT;
ALTER TABLE storyboards ADD COLUMN source_prompt_hash TEXT;
ALTER TABLE storyboards ADD COLUMN h3_mode TEXT;
ALTER TABLE storyboards ADD COLUMN optimized_prompt TEXT;
ALTER TABLE storyboards ADD COLUMN generated_by_model TEXT;
ALTER TABLE storyboards ADD COLUMN generated_at TEXT;
ALTER TABLE storyboards ADD COLUMN user_edited INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storyboards ADD COLUMN provider_prompt TEXT;
ALTER TABLE storyboards ADD COLUMN prompt_version TEXT;
ALTER TABLE video_generations ADD COLUMN config_id INTEGER;
ALTER TABLE video_generations ADD COLUMN episode_id INTEGER;
ALTER TABLE video_generations ADD COLUMN started_at TEXT;
ALTER TABLE video_generations ADD COLUMN elapsed_seconds REAL;
ALTER TABLE video_generations ADD COLUMN generation_elapsed_seconds REAL;
ALTER TABLE video_generations ADD COLUMN output_duration REAL;
ALTER TABLE video_generations ADD COLUMN estimated_cost REAL;
ALTER TABLE video_generations ADD COLUMN calculated_cost REAL;
ALTER TABLE video_generations ADD COLUMN actual_cost REAL;
ALTER TABLE video_generations ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE video_generations ADD COLUMN generation_metadata TEXT;
ALTER TABLE video_generations ADD COLUMN cost_metadata TEXT;
CREATE TABLE IF NOT EXISTS video_cost_prices (
  id INTEGER PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL,
  billing_type TEXT NOT NULL, price REAL, currency TEXT NOT NULL DEFAULT 'CNY',
  resolution TEXT NOT NULL DEFAULT '*', effective_date TEXT NOT NULL,
  UNIQUE(provider, model, resolution, effective_date)
);
CREATE TABLE IF NOT EXISTS video_cost_quotes (
  token TEXT PRIMARY KEY, requests_json TEXT NOT NULL, settings_hash TEXT NOT NULL,
  consumed_json TEXT NOT NULL DEFAULT '[]', expires_at TEXT NOT NULL
);
