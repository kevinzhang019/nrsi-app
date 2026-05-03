-- Per-play archive. One row per completed plate appearance, written once at
-- the watcher's Final exit from `liveData.plays.allPlays`. Powers per-inning
-- hitter and pitcher rollups on the history detail page; the (game_pk,
-- at_bat_index) PK makes the bulk upsert idempotent across watcher retries.
--
-- We intentionally store names + sides denormalized on the row so the history
-- page can render rollups without a join against a players table — at-bat
-- counts per game are small (~70-90), and the boxscore-derived names rarely
-- change. `raw` keeps the full source play for forward-compat.

create table if not exists plays (
  game_pk        integer  not null references games(game_pk) on delete cascade,
  at_bat_index   integer  not null,
  inning         smallint not null check (inning >= 1),
  half           text     not null check (half in ('Top','Bottom')),
  batter_id      integer  not null,
  batter_name    text     not null,
  batter_side    text,
  pitcher_id     integer  not null,
  pitcher_name   text     not null,
  pitcher_hand   text,
  event          text,
  event_type     text,
  rbi            smallint not null default 0,
  runs_on_play   smallint not null default 0,
  end_outs       smallint,
  away_score     smallint,
  home_score     smallint,
  raw            jsonb    not null,
  captured_at    timestamptz not null default now(),
  primary key (game_pk, at_bat_index)
);

create index if not exists plays_by_inning  on plays (game_pk, inning, half);
create index if not exists plays_by_batter  on plays (game_pk, batter_id);
create index if not exists plays_by_pitcher on plays (game_pk, pitcher_id);
