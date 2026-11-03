-- Preserve the previous staff-account presentation order across row updates.
ALTER TABLE "staff_accounts" ADD COLUMN "_record_order" SERIAL NOT NULL;
