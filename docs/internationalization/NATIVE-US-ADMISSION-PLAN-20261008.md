# Native US admission — smallest coherent next lot

8 October 2026. Source plan only; no native edits, execution, migration or deployment. This is admission and shared-controller work, not a claim that the full US native ERP is finished.

## Verified baseline

Protected native checkout: `D:/Codex-Zentra-Temporary/2026-10-08/international-native`, HEAD `0f53e632982fdc9cdc43d5e5a322aa33cb565571`. Protected current CH corrections: `D:/Codex-Zentra-Temporary/2026-10-08/app-current-corrections`, HEAD `56daec734529c06bae6dd73729c74b3a655edb86`. Both remained clean. App, bridge, CompanyAccountGate and company_account.rs match between these checkouts; account_cloud.rs contains the additional US gateway. Do not copy a desktop tree or replace the CH implementation.

Existing shared discovery is reusable: `lib/account-workspaces.ts:6` exposes `AccountWorkspace {organizationId,name,edition:'ch_legacy'|'us_experimental',role}`; `accountWorkspacesForUser(userId, options?)` reads CH and US membership metadata without granting access. `GET /api/account/workspaces` deliberately accepts browser Auth only, checks the same user again and rechecks closed US flags. Expired US offers can remain discoverable: opening still requires fresh authority. `/appareil` currently calls only `membershipsForUser`, and its DeviceApproval form submits to the CH approval route.

Four native admission blockers are explicit:

1. `lib/account.ts:152` requireDeviceSession joins CH organizations, subscriptions, license_activations and organization_members. `lib/international/runtime-bindings.ts:29` still calls that reader before requireUsWorkspaceAccess. A valid USD business authority alone cannot currently issue a usable native US session.
2. `desktop/src-tauri/src/account_cloud.rs:1210` requires a signed licence on every successful exchange; finalize_exchange at `:1252` installs it. validate_session at `:1571` also requires an `org_` prefixed UUID, whereas US creation uses a plain UUID. Neither requirement should be relaxed globally.
3. `App.tsx:137` first loads CH Workspace and CH licence. `:298-355` then requires Swiss onboarding/settings/NOGA and derives readOnly from that licence. CompanyAccountGate calls the CH snapshot resolver; `WorkspaceApp.tsx:561` starts CH project-sync. Those gates must not run for US.
4. The US controller lives in SettingsScreen (`WorkspaceApp.tsx:5097/:5382`). TS `internationalErp.ts:90` and Rust international_erp.rs accept only schema1, so current schema2/3 books cannot yet be opened there.

## Existing ports to keep

| Port | Current signature / location | Preservation boundary |
| --- | --- | --- |
| CH linking | desktopApi.startCloudAccountLink(), pollCloudAccountLink(): Promise<CloudAccountState>; openCloudAccountLink(): Promise<string>; disconnectCloudAccount(); bridge.ts:4903 | Existing no-argument calls and CH DTO/secret version remain valid. |
| CH company resolution | resolveConnectedCompany(organizationId, choice:'auto'|'open'|'publish'='auto'): Promise<CompanyAccountResolution>; bridge.ts:4928; Rust company_account.rs:70 | Snapshot receive/publish never opens US and never rewrites unrelated local CH data. |
| Local identity | getFormDraftIdentity(): Promise<{memberId?,memberContextNonce?}>; bridge.ts:6691 | Nonce is an anti-race context, never remote authority. |
| ERP client | createInternationalErpClient(invoke); read(origin), execute(request,origin), readRevision(origin,organizationId), readChanges(origin,organizationId,afterRevision,limit=100); internationalErp.ts:138 | Credentials and tenant selection stay in Rust; no WebView fetch bypass. |
| ERP controller | new InternationalErpSession(client:PilotClient, origin:WorkspaceMutationOrigin, key?); subscribe/getSnapshot/activate/invalidate/refresh/synchronize/execute/retry/startRealtime(visible); internationalErpSession.ts:25 | One session, exact pending body/key, shared CAS/delta. No SQLite US financial replica. |
| Origin | WorkspaceMutationOrigin {workspaceScope,memberContextNonce}; captureWorkspaceMutationOrigin(workspace,identity), mutationOriginInvokeArgs(origin); workspaceMemberOrigin.ts:15 | Capture before first await; never replace the nonce mid-operation. |
| IPC | read_international_erp(state,scope,nonce); execute_international_erp(state,request,scope,nonce); read_international_erp_revision(state,scope,nonce); read_international_erp_changes(state,after_revision,limit,scope,nonce); international_erp.rs:118 | Fixed HTTPS host/routes, bounded payloads, no redirects or automatic POST retries. |
| Business authority | requireUsWorkspaceAccess(org,user,module='gestion'); saas-authority-d1.ts:116 | Existing USD catalogue/evidence/membership/revocation authority; not CH founder access, licence or account-wide trial. |

CloudAccountState currently contains only status/organizationId/name/role/session expiry and public linking fields (`bridge.ts:251`, Rust account_cloud.rs:497). It has no country, currency, Auth user or capability discriminator.

## Minimum implementation slice

**A. Explicit selection and isolated US admission.** Reuse accountWorkspacesForUser on the authenticated browser approval page. Display company name and edition; require an explicit choice when there are several spaces. A discovery descriptor or submitted edition grants nothing. Existing devices stay on the CH protocol and are offered only CH-compatible spaces. A new versioned native linking request declares supported editions/protocol/schema cap; unsupported selections return an upgrade instruction, never fall back to CH.

Add a closed, versioned US issuer and reader (proposed, not existing): `requireUsDeviceSession(request, allowedRoles?) -> {sessionId,userId,installationId,organizationId,role,subscriptionId,edition:'us_experimental'}`. Its opaque, installation-bound credentials are stored hashed server-side and protected in Rust. Reuse fresh requireUsWorkspaceAccess for every approval/exchange/request and pre/postflight check. Check ready creation, USD catalogue and environment, verified evidence, role, revocation, expiry and seat capacity. The current helper returns seatLimit; explicitly validate actual active-seat occupancy rather than assuming that field proves capacity.

Prefer additive US credential/challenge records and fixed US link/me/revoke routes, isolated from the existing CH issuer. These records are credentials only, not a second company, financial or subscription authority. Keep CH approve/poll/me/session behavior intact. A versioned dispatcher can reuse the approval UI and route a server-owned challenge to CH or US; protocol/edition supplied in a URL must never override that challenge. US exchange contains no CH licence. No insertion into organizations, subscriptions or license_activations to make the CH reader accept US.

Rust needs a discriminated protected admission type: legacy CH remains its existing validated secret; US has its own exact UUID/protocol/country/currency constraints. Public selection metadata is detached and contains no bearer. Do not make legacy signed-license fields optional globally. Poll uses the protected pending protocol; logout revokes the corresponding exact protocol session, including an incomplete local adoption. Switching cannot reuse a token from another edition/company.

**B. Dispatch before CH gates.** Add a native selection/admission gate before loadWorkspace, Swiss onboarding and CompanyAccountGate. Proposed public state is a discriminated `NativeWorkspaceSelection = {edition:'ch_legacy',organizationId?,localWorkspaceScope?} | {edition:'us_experimental',organizationId,userId,role,country:'US',currency:'USD',configurationRevision,supportedSchemaVersion,contextNonce}`; the local metadata is not an entitlement. Validate fresh admission/configuration in Rust before exposing a US-ready state. Missing or ambiguous country is a review/selection state, never inferred from language or a US address.

The CH branch executes the current App/CompanyAccountGate/WorkspaceApp and licensing flow unchanged. The US branch mounts a dedicated US shell/controller using the same visual shell vocabulary, but receives ErpState instead of manufacturing a CH Workspace. It never calls completeOnboarding(CH), resolve_connected_company, CH snapshot sync, licence refresh as its admission, or a CH financial IPC command. Existing CH databases, drafts, licence and snapshot preferences remain retained; switching country is not data migration.

**C. One admitted US controller.** Lift useInternationalErp into that selected US shell, remove the Settings-only second mount, and pass session/snapshot to US menus/settings. Mount exactly one controller per `{edition,organizationId,userId,role,contextNonce,cap}`. Reuse visible-app three-second head checks, deltas, reconnect/backoff and shared write lock; unchanged heads do not reload a complete book. Invalidate synchronously on Auth/role/company/cap loss and mask old results at render. Clear pending reviews/drafts and generated URLs at the same boundary. Retain byte-exact retry only while the same admitted identity remains; never replay another company's request.

The current Rust stamp calls inbox_read_stamp, which requires CH automation binding and CH work-notes scope (`account_cloud.rs:310`). Add a US stamp based on the protected US session, selected-US metadata, secret revisions and context nonce; do not bypass the guard with a fake CH binding. Capture and compare it before and after all network outcomes. Keep locks off the network wait. The UI still supplies only the original scope/nonce, not a bearer or authority claim.

**D. Align the protocol before enabling the branch.** Carry explicit schema cap through TS and Rust full/head/delta/request/receipt validation and server X-Zentra-Erp-Schema-Version. Preserve schema1 reads/replays; schema3 needs both purchasing2 and projects3 server flags. Reuse the shared domain contract (including projects/purchasing), via a versioned source manifest/package and cross-consumer fixtures; never import server credential bindings into native UI. Newer unsupported books show upgrade-required without dropping fields or rebuilding a CH copy. Native sales retain exact owner/admin/accountant roles; production invoice issuance stays disabled until a trusted provider is actually bound.

This lot is complete when a fresh native installation can authorize a real existing US workspace under the existing USD authority, choose CH/US explicitly, open the correct authoritative US state, navigate without stopping its one background session, and switch back to an untouched CH workspace. It does not include banking, US payroll, uploaded original documents, offline US writes, or a production tax provider. Full native project/invoice/report/export screens follow this admission milestone.

## Exact edit surface proposed for the next lot

Web, relative to international-site: `app/appareil/page.tsx`, `components/device-approval.tsx`, `lib/account-workspaces.ts` only if an adapter is needed; new versioned US device issuer/reader/handlers and fixed route files; `lib/international/runtime-bindings.ts`, `workspace-server.ts`, `export-bindings.ts` to choose the correct native reader without cookie fallback. Reuse existing `saas-authority.ts/-d1.ts`; no change to commercial evidence or existing Stripe Price IDs. Additive credential migration proposed only, tested locally before any approval for production.

Native, relative to the protected native root: `desktop/src/App.tsx`, `bridge.ts`, `CloudAccountPanel.tsx`, `useInternationalErp.ts`, `internationalErp.ts`, `internationalErpSession.ts`, `workspaceMemberOrigin.ts`; new country/admission gate and US controller context. Rust: `desktop/src-tauri/src/account_cloud.rs`, `international_erp.rs`, `member_context.rs`, `lib.rs` IPC registration; a separate typed US admission module is preferable to relaxing the CH structures. Shared contract dependencies include `lib/international/erp-request.ts`, `runtime-types.ts`, `runtime-validation.ts`, `runtime-sync.ts`, `invoicing.ts`, `purchasing.ts`, `projects.ts`, `erp-schema-capability.ts`, and their pure dependencies. Freeze the manifest and test both consumers before enabling cap3. Do not modify CH accounting/database/QR engines or widen tauri.conf.json CSP.

## Acceptance controls

- CH-only old client/session: unchanged DTO and secret reading, signed licence, QR/VAT/SQLite/history/offline opening, CH resolution and revocation; no US API attempts. A valid CHF licence or founder grant does not open US. A USD admission does not open any CH financial command.
- Same Auth user in two CH/US companies: explicit selection; exact org/user/edition on every call; preserve local CH data; no automatic publish/import/merge. Wrong user/org/installation/token family and forged country/role/metadata fail closed.
- US approval/exchange: stale/revoked/expired membership or authority, full seats, wrong USD Price/environment, consumed/expired challenge, double exchange, lost exchange response and incomplete local adoption/logout. No new live offers or implied trial.
- Races: revoke/role change during list/approval/read/write; switch during held full/head/delta response or pending exact retry. One controller/poll loop only, no CH background sync under US; late response never paints the previous company.
- Protocol1/2/3 fixtures across TS/Rust; closed flags before/after response; unsupported book needs upgrade. Exact financial minor units, canonical receipt hashes and origin nonce preserved.
- UI functional checks in four existing languages, keyboard/mobile/large text, explicit CH/US labels and actionable access errors. No new visual redesign in this slice.
- Local mocked transport and source tests are not production evidence. A staging two-installation/account/revocation check and native build/smoke remain required before release. No production migration or data move is authorized by this plan.

## Safety and rollback

New admission flags default closed. Disable the US native flag to stop new admission and US financial reads/writes; do not erase sessions, receipts or company data. Existing CH protocol and data remain usable. Reverting shell dispatch removes only the experimental US branch. Secrets never enter JavaScript, URLs, logs, exports, shared financial state or manual backups. Authorize from fresh server records, not editable Supabase user_metadata. No change of data region or claim of legal/security certification.
