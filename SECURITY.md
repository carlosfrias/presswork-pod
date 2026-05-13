# Security Policy

## Reporting a vulnerability

Email **ben.bracamonte@gmail.com** with a description of the issue and reproduction steps. Please **do not** open a public GitHub issue for security reports; we'll coordinate disclosure privately.

Expected response: acknowledgement within 7 days. Severity and fix timeline depend on impact.

## Scope

In scope:
- This repo's agent code (`packages/scout`, `packages/design`, `packages/listing`, `packages/ledger`) and shared libraries (`packages/shared`, `packages/shared_py`).
- Database migrations under `infra/supabase/migrations/`.
- CI workflows under `.github/workflows/`.
- Secret handling, OAuth refresh, and rate-limit guards.

Out of scope (report directly to the vendor):
- Vulnerabilities in Etsy, Printify, fal.ai, Anthropic, Supabase, Resend, or Railway.
- Vulnerabilities in third-party npm/PyPI packages we depend on — report upstream; Dependabot will surface fixes here once published.

## Supported versions

Only `main` is supported. There are no long-term-support branches.

## Secret handling

- All credentials live in Railway environment variables. Nothing is committed to the repo.
- The shared logger (`packages/shared/src/logger.ts`) redacts a fixed set of secret-shaped keys before emit; if you find a code path that logs a sensitive value not on that list, that's a vulnerability — report it.
- If you suspect a secret has been exposed (e.g. accidentally committed, leaked in a log, used on an untrusted host): rotate the secret in Railway **and** the upstream vendor (Etsy / Printify / Supabase / etc.) immediately, then email the maintainer.

## Coordinated disclosure

Private email first. Once a fix is in `main` and any rotated secrets are settled, a public summary may be added to release notes. We will not publicly attribute reporters without prior agreement.
