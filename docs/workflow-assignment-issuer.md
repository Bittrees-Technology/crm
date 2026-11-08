# CRM assignment issuer

The internal issuer reads a server-owned assignment, checks the current task
version and project, and requires the host's current source and Roles
authorization in the transaction. For a result the authorization must also
verify the exact Workflows run and lease. The caller supplies no signing key.

The result transaction writes a separate receipt keyed by the original
operation ID with a uniqueness constraint per assignment. CRM task fields
and status are preserved. A retry reads the committed row and rejects a
different payload. The issuer signs only after the transaction resolves.

The schema is additive and the issuer has no default route or production
registration. The protected gateway must supply an explicit enrolled actor,
approved assignment binding, current authority verifier, and protected CRM
service adapter. The fixture uses synthetic keys and two temporary databases.
