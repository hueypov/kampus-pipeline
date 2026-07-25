# Isolation and safety

Verify the data and permission boundary that the target repository documents
for the audited journey. Examples may include tenant separation, role-based
access, ownership checks, or test-data containment; the repository contract
defines which one applies.

Use only safe fixtures or identities. Do not probe unrelated accounts, real
customer data, or production systems. Pass when the documented boundary holds;
fail when the second fixture/identity can observe or alter data it should not;
mark blocked when the repository does not provide a safe way to test it.
