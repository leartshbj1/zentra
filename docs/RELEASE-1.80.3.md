# Zentra 1.80.3 — Workspace and collaborator identity

## Changes

- Device authorization explicitly chooses the account workspace. A configured local company, even empty, requires confirmation before opening a different saved company. The existing `.zentra` backup and restore path preserves local data.
- Account settings expose workspace switching while keeping the previous workspace until approval completes. Automation remains bound to the selected organization.
- Invitations require first and last name on the server. Native account verification receives the membership name. Quote author identity is frozen at issue time and displayed in preview and PDF.
- Shorter payroll guidance, direct purchase correction actions, one purchase search, collapsible shared Automation settings, and mobile-safe account controls.
- Automation is presented as a CHF 15 monthly workspace option. The accompanying server release protects provider calls and workers with entitlement, role, consent and feature checks, while preserving manual Support workflows.

## Local validation (2026-09-22)

- Native TypeScript compile and 71 targeted UI/unit tests passed.
- Server TypeScript compile and 220 targeted tests passed in the separate website publication checkout, including shared workspace membership, invitation acceptance, manual Support without Automation, cancellation during analysis, refund replay, and paid reactivation.
- Browser checks used synthetic data only: desktop dark account settings; mobile light payroll and Automation settings; German mobile dark workspace choice; opening the synthetic Windows workspace returns its client and invoice.
- Impeccable source scan completed without findings on the modified account, Automation, payroll and invitation surfaces.

## Release gates

Native Rust/PDF tests, package compilation, installed package smoke tests, artifact verification, signing and publication must pass before release. This document is preparation evidence, not publication confirmation.
