CREATE TABLE "patient_portal_accounts" (
    "patient_id" TEXT NOT NULL PRIMARY KEY REFERENCES "clinic_patients"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "activation_hash" TEXT,
    "activation_expires_at" TEXT,
    "password_hash" TEXT,
    "salt" TEXT,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TEXT
);

CREATE TABLE "patient_portal_sessions" (
    "token_hash" TEXT NOT NULL PRIMARY KEY,
    "patient_id" TEXT NOT NULL REFERENCES "patient_portal_accounts"("patient_id") ON DELETE CASCADE ON UPDATE CASCADE,
    "last_seen" TEXT NOT NULL,
    "expires_at" TEXT NOT NULL
);

CREATE INDEX "patient_portal_sessions_patient_id_idx" ON "patient_portal_sessions"("patient_id");
