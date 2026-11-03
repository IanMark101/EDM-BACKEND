-- CreateSchema
-- CreateTable
CREATE TABLE "staff_accounts" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TEXT,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "staff_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_sessions" (
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    "last_seen" TEXT NOT NULL,
    "expires_at" TEXT NOT NULL,

    CONSTRAINT "staff_sessions_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "clinic_patients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dob" TEXT NOT NULL,
    "phone" TEXT NOT NULL DEFAULT '',
    "doctor_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'Clinic registration',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TEXT NOT NULL,

    CONSTRAINT "clinic_patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinic_visits" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "doctor_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "signed_at" TEXT,
    "history" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TEXT NOT NULL,
    "clinical" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "clinic_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "laboratory_reports" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "test_name" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "unit" TEXT NOT NULL DEFAULT '',
    "collected_at" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'requested',
    "requested_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TEXT,
    "history" JSONB NOT NULL DEFAULT '[]',
    "source_ref" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TEXT NOT NULL,
    "layout" TEXT NOT NULL DEFAULT 'general',
    "measurements" JSONB NOT NULL DEFAULT '[]',
    "specimen" TEXT NOT NULL DEFAULT '',
    "report_comment" TEXT NOT NULL DEFAULT '',
    "urgency" TEXT NOT NULL DEFAULT 'routine',
    "contact" JSONB NOT NULL DEFAULT '{}',
    "doctor_review" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "laboratory_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_invoices" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "total" BIGINT NOT NULL,
    "paid" BIGINT NOT NULL DEFAULT 0,
    "payments" JSONB NOT NULL DEFAULT '[]',
    "source_ref" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TEXT NOT NULL,

    CONSTRAINT "billing_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quality_reviews" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "patient_id" TEXT,
    "record_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "owner_role" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "evidence" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TEXT,
    "created_at" TEXT NOT NULL,

    CONSTRAINT "quality_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_imports" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'held',
    "linked_patient_id" TEXT,
    "received_at" TEXT NOT NULL,

    CONSTRAINT "source_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_facts" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "patient_key" TEXT NOT NULL,
    "visit_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "total" BIGINT NOT NULL DEFAULT 0,
    "paid" BIGINT NOT NULL DEFAULT 0,
    "refreshed_at" TEXT NOT NULL,

    CONSTRAINT "warehouse_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_runs" (
    "id" TEXT NOT NULL,
    "at" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "summary" JSONB NOT NULL,

    CONSTRAINT "warehouse_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_history" (
    "id" TEXT NOT NULL,
    "at" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "patient_id" TEXT,
    "detail" TEXT NOT NULL,

    CONSTRAINT "activity_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "visit_workflow" (
    "visit_id" TEXT NOT NULL,
    "checked_in_at" TEXT,
    "billing_ready_at" TEXT,
    "queue_key" TEXT,

    CONSTRAINT "visit_workflow_pkey" PRIMARY KEY ("visit_id")
);

-- CreateTable
CREATE TABLE "staff_notifications" (
    "id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "recipient_role" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "patient_id" TEXT,
    "entity_id" TEXT NOT NULL,
    "href" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    "read_at" TEXT,
    "archived_at" TEXT,
    "event_key" TEXT NOT NULL,

    CONSTRAINT "staff_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_accounts_username_key" ON "staff_accounts"("username");

-- CreateIndex
CREATE UNIQUE INDEX "billing_invoices_visit_id_key" ON "billing_invoices"("visit_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_external_unique" ON "source_imports"("source", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "one_active_checkin" ON "visit_workflow"("queue_key");

-- CreateIndex
CREATE UNIQUE INDEX "notification_delivery_unique" ON "staff_notifications"("recipient_id", "event_key");

-- AddForeignKey
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "staff_accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "clinic_patients" ADD CONSTRAINT "clinic_patients_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "staff_accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "clinic_visits" ADD CONSTRAINT "clinic_visits_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "clinic_patients"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "clinic_visits" ADD CONSTRAINT "clinic_visits_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "staff_accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laboratory_reports" ADD CONSTRAINT "laboratory_reports_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "clinic_patients"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "laboratory_reports" ADD CONSTRAINT "laboratory_reports_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "clinic_visits"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "clinic_patients"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "clinic_visits"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quality_reviews" ADD CONSTRAINT "quality_reviews_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "clinic_patients"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "source_imports" ADD CONSTRAINT "source_imports_linked_patient_id_fkey" FOREIGN KEY ("linked_patient_id") REFERENCES "clinic_patients"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "visit_workflow" ADD CONSTRAINT "visit_workflow_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "clinic_visits"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "staff_notifications" ADD CONSTRAINT "staff_notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "staff_accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

