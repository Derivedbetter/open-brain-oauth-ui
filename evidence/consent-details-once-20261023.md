# Consent details race candidate — 2026-10-23

Assignment: Lead 80aca9a0-b0f8-4478-8e27-46696f0e20ae; capture root 982ba3eb; existing assignment 040935c3. This is an implementation evidence contract for the assigning Advisor to reconcile with the controlling Board contract. It does not claim owner acceptance, independent review, or release approval.

## Scope and acceptance

The page must share the first authorization-details request and its result between the explicit post-verification `show(session)` and overlapping or later auth-event `show(session)` calls. A valid first auto-approved redirect must survive the later call. Pending authorization still requires the existing explicit Approve or Deny action. Denied, expired and invalid responses must retain their error behavior. A different authenticated user or sign-out must not reuse another user's result.

Checks: `npm ci --ignore-scripts --no-audit --no-fund`, then `npm test`. The 24 `OTP auth event` regressions execute each actual consent page script against both a controlled SDK mock and the installed pinned AuthClient 2.112.4, with in-flight and already-completed first responses and auto-approved, pending and error outcomes. Four additional checks cover user change, token refresh and sign-out during an outstanding redirect result. Existing explicit approval and new approval/denial error checks remain mandatory. No backend, auth configuration, gateway or dependency changes are permitted.

Real-use acceptance remains pending: after independent reviews and authorized release, the owner must complete a newly initiated connection and observe the intended client return. This candidate does not manufacture a new real authorization, email, OTP, capture, token exchange or provider request.

## Current deployed artifact and provenance

Read-only retrieval on 2026-10-23 established that the live Pages consent HTML was byte-identical to `docs/oauth/consent/index.html` at origin/main `872686f1a05dbe3b45af289c4337afc00f77dff2`. Its SHA256 was `e38d1e410921bce207a9104a249a30ff2ddb25d081331882e440e7e3df7cfbe4`.

The GitHub Pages latest-build API reported status `built`, commit `872686f1a05dbe3b45af289c4337afc00f77dff2`, created `2026-10-20T18:26:55Z`, updated `2026-10-20T18:27:16Z`. Git commit author and committer timestamp were both `2026-10-20T14:26:53-04:00`; commit subject was the merge of PR 13. The original local checkout was stale at `15f0ab5a693d1baecdb22f11687772860697a393` and was not modified. Candidate branch is `codex/consent-details-once-20261023`, isolated at `/mnt/fast/dev/open-brain-oauth-ui-details-once`, based on the verified current origin commit.

## Actual incident versus controlled reproduction

The assigning Advisor supplied this sanitized incident evidence: authorize 302 at 17:15:54, OTP 200 at 17:16:17, verify 200 at 17:17:10.114, first details 200 at .506 with auto_approved=true, another details 400 at .754 with validation_failed and “authorization request cannot be processed”; authorization approved and expiry 17:25:54; no token call. This worker did not independently inspect the original private request or database record.

The controlled fixture exercises the actual deployed ordering: verifyOtp emits SIGNED_IN before returning its session; the page independently calls show from the verification continuation and schedules show from the auth callback. The fixture gives the first details request the selected result and rejects any second details request as consumed. All 24 overlap/late-event cases failed against the deployed baseline, and all 24 passed the candidate. The full candidate suite passed 68/68. `git diff --check` passed. Deno is not installed on this host, so `npm run check` was not run; the tests render the actual edge handler via Node's TypeScript stripping and execute its returned module script.

This proves the UI's request sharing and result retention under the observed event order. It does not prove a new live external client connection, nor that an already-consumed backend request can generate another redirect. No such backend capability is assumed: the fix retains and reuses the original successful response in the same page's memory. It does not survive reload, new tabs or a genuinely lost first response.

## Candidate byte pins

- Static consent HTML: `sha256:0248e822e067463f9ea17eb4f651eb4f43042a867593417e888d30e011508b3d`.
- Edge consent source: `sha256:cedd03198abf422a932b31fc4d062140eafc8f17da715740971c776fda263039`.
- Consent regression suite: `sha256:bd1dea2ff6093b254c44c80450b283b340e3f0c16fbf3134bfcdb7799a21c06d`.

## Release, rollback and remaining gates

No deployment or production mutation occurred. The assigning Advisor must arrange the fresh Codex peer check, then one accepted Claude review request for the immutable candidate, verify the review PASS and applicable CI, notify the Lead, and apply the existing release authorization before deployment. The edge fallback source is kept aligned but must not be independently deployed without that approval.

Rollback target is the exact deployed consent file at `872686f1a05dbe3b45af289c4337afc00f77dff2`, SHA256 `e38d1e410921bce207a9104a249a30ff2ddb25d081331882e440e7e3df7cfbe4`. Use a reviewed revert commit or restore that known file through the existing Pages release path; verify Pages build success and live byte hash. If the edge fallback is released too, revert its source in the same change and use its existing authorized release path. Do not revoke clients, change backend validation, or change authentication settings for this rollback.

House rules reference a build-closeout skill; no matching file was found within the installed cot-codex-operations 0.3.44 package. This does not replace any Lead-owned closeout requirement.
