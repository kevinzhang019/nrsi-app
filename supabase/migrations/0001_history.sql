-- Historical games + per-inning predictions.
--
-- One row per finished game in `games`, plus one row per (game, inning, half)
-- in `inning_predictions` capturing the prediction made AT THE START of that
-- half-inning (clean state: 0 outs, 0 bases). The watcher writes both at the
-- moment a game's status flips to Final (workflows/game-watcher.ts ~L585).
--
-- Service role is the only writer — RLS stays off; reads from server
-- components use the same key.

create table if not exists games (
  game_pk         integer primary key,
  game_date       date     not null,
  start_time      timestamptz,
  status          text     not null,
  detailed_state  text,
  away_team_id    integer,
  away_team_name  text,
  away_runs       integer,
  home_team_id    integer,
  home_team_name  text,
  venue_id        integer,
  venue_name      text,
  home_runs       integer,
  linescore       jsonb,
  weather         jsonb,
  env             jsonb,
  lineups         jsonb,
  pitchers_used   jsonb,
  final_snapshot  jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists games_game_date_idx on games (game_date desc);

create table if not exists inning_predictions (
  game_pk             integer  not null references games(game_pk) on delete cascade,
  inning              smallint not null check (inning between 1 and 12),
  half                text     not null check (half in ('Top','Bottom')),
  p_no_run            double precision not null,
  p_run               double precision not null,
  break_even_american integer,
  per_batter          jsonb    not null,
  pitcher             jsonb,
  env                 jsonb,
  lineup_stats        jsonb,
  defense_key         text,
  actual_runs         integer,
  captured_at         timestamptz not null,
  primary key (game_pk, inning, half)
);

create index if not exists inning_predictions_game_pk_idx on inning_predictions (game_pk);
