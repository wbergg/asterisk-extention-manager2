-- Repair extensions stored with a blank dialplan context.
--
-- `PUT /extensions/:pbx/:number` bound the caller's value straight into
-- `COALESCE(?, context)`, and SQL treats '' as a value rather than as absent, so
-- clearing the field in the GUI stored an empty string instead of leaving the
-- column alone. The expansion then read that empty string as an attribute
-- *removal* — `tuples()` deletes any key whose value is '' — and pushed an
-- endpoint carrying no `context` at all, which left it on Asterisk's own
-- default context, confusingly also named `default`.
--
-- Nothing reported it. The objects pushed cleanly, the PBX reported
-- `converged`, the phone registered, and calls from it landed nowhere near the
-- generated dialplan. `resolveContext` in routes.ts now normalizes blank input
-- at both write paths; this repairs rows written before that.
--
-- Resolved per-PBX against the configured `dialplan.context` so a renamed
-- managed context is honoured, falling back to the shipped default. json_valid
-- guards the extract: a malformed settings blob would otherwise abort the
-- migration rather than fall through.

UPDATE extension
   SET context = COALESCE(
         NULLIF(
           (SELECT CASE
                     WHEN json_valid(p.settings_json)
                     THEN json_extract(p.settings_json, '$.dialplan.context')
                   END
              FROM pbx p WHERE p.id = extension.pbx_id),
           ''
         ),
         'aem-internal'
       )
 WHERE context IS NULL OR TRIM(context) = '';
