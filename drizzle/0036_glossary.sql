CREATE TABLE "glossary_terms" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "glossary_terms_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"guild_id" text NOT NULL,
	"key" text NOT NULL,
	"term" text NOT NULL,
	"variants" text[] DEFAULT '{}'::text[] NOT NULL,
	"definition" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "glossary_terms_guildId_key_unique" UNIQUE("guild_id","key")
);
