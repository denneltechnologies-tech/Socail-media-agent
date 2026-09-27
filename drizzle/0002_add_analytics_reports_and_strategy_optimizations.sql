CREATE TABLE IF NOT EXISTS "analytics_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"report_type" varchar(50) DEFAULT 'custom' NOT NULL,
	"period" varchar(50) NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone NOT NULL,
	"summary" text,
	"metrics" jsonb NOT NULL,
	"top_posts" jsonb DEFAULT '[]'::jsonb,
	"account_breakdowns" jsonb DEFAULT '[]'::jsonb,
	"platform_breakdown" jsonb DEFAULT '[]'::jsonb,
	"trends" jsonb DEFAULT '[]'::jsonb,
	"insights" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategy_optimizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"period_days" integer DEFAULT 7 NOT NULL,
	"posts_analyzed" integer DEFAULT 0 NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb,
	"analysis_data" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "analytics_reports" ADD CONSTRAINT "analytics_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "strategy_optimizations" ADD CONSTRAINT "strategy_optimizations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_reports_created_idx" ON "analytics_reports" USING btree ("created_at" desc);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_reports_project_created_idx" ON "analytics_reports" USING btree ("project_id","created_at" desc);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_optimizations_account_idx" ON "strategy_optimizations" USING btree ("account_id","created_at" desc);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_optimizations_created_idx" ON "strategy_optimizations" USING btree ("created_at" desc);
