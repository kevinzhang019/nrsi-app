-- Allow per-inning predictions for extras (10+). The original 0001 migration
-- constrained inning between 1 and 12; extra-inning games can run longer.
-- Drop the upper bound and keep only inning >= 1.

alter table inning_predictions
  drop constraint if exists inning_predictions_inning_check;

alter table inning_predictions
  add constraint inning_predictions_inning_check check (inning >= 1);
