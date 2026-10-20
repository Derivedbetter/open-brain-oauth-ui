# Open Brain web gateway

OAuth-protected remote MCP gateway for Tony's Gemini Spark and Perplexity web clients. It forwards approved calls to the existing vanilla Open Brain and never creates another brain.

## Boundaries

- Open Brain is operational memory, not Continuity, COTA, Current-State Tracker, or owner-acceptance authority.
- No automatic chat capture. Capture tools require an explicit request or applicable standing owner capture instructions. Standing instructions do not authorize passive transcript capture; preserve required exact wording, privacy exclusions and source provenance.
- The vanilla Open Brain repository and Edge Function remain unchanged.
- Browser clients receive short-lived OAuth tokens, never the long-lived Open Brain access key.
- OAuth tokens are validated and then terminated at this gateway; they are not passed to the upstream Open Brain.

## Components

- `open-brain-web-gateway`: OAuth-protected Streamable HTTP MCP relay with client/user allowlists, exact and summary aliases, authoritative post-write receipts, and a server-enforced `/readonly` route that exposes only the seven bounded read tools.
- `docs/`: GitHub Pages same-page email-code sign-in and OAuth consent UI, plus privacy and terms pages.
- `open-brain-oauth-ui`: deployable source retained as a fallback for a future custom Supabase domain; the default Supabase Functions domain intentionally rewrites HTML to plain text.

## Required live configuration

1. Supabase OAuth 2.1 Server enabled with authorization path `/oauth/consent`.
2. Auth Site URL: `https://derivedbetter.github.io/open-brain-oauth-ui`.
3. Authorization path: `/oauth/consent/` and redirect allowlist includes `https://derivedbetter.github.io/open-brain-oauth-ui/**`.
4. Pre-registered confidential clients for Gemini full access, Gemini Spark read-only access, Perplexity, and Claude.
5. Edge secrets:
   - `OPEN_BRAIN_ALLOWED_EMAILS=<approved-email>`
   - `OPEN_BRAIN_OAUTH_CLIENT_IDS=<full-gemini-client-id>,<perplexity-client-id>,<claude-client-id>`
   - `OPEN_BRAIN_READ_ONLY_OAUTH_CLIENT_IDS=<read-only-gemini-client-id>`
   - optional `OPEN_BRAIN_OAUTH_AUDIENCES=authenticated,<gateway-url>`
   - existing `MCP_ACCESS_KEY` remains server-side.

Dynamic client registration stays disabled for the pilot.

## Validation

```powershell
npm test
npx -y supabase@latest functions deploy open-brain-oauth-ui --project-ref zoptbgumxukgpkgbtnpz --no-verify-jwt
npx -y supabase@latest functions deploy open-brain-web-gateway --project-ref zoptbgumxukgpkgbtnpz --no-verify-jwt
```

Test discovery and unauthenticated failure before connecting a client:

- `GET /functions/v1/open-brain-web-gateway/.well-known/oauth-protected-resource` returns protected-resource metadata.
- `GET /functions/v1/open-brain-web-gateway/readonly/.well-known/oauth-protected-resource` returns distinct read-only protected-resource metadata.
- unauthenticated `POST /functions/v1/open-brain-web-gateway` returns `401` and an OAuth `WWW-Authenticate` challenge.
- authenticated `tools/list` on `/functions/v1/open-brain-web-gateway/readonly` omits every write/delete tool, and direct write calls fail closed.
- OAuth clients are endpoint-scoped: read-only client tokens are rejected by the full-access route, and full-access client tokens are rejected by the read-only route.
- invalid user, client, issuer, audience, and expired tokens fail closed without an upstream call.

## Rollback

Revoke the affected OAuth client, disable the connector in Gemini or Perplexity, disable Supabase OAuth Server if no clients remain, and delete only the two gateway Edge Functions. Existing Open Brain data and the ChatGPT, Codex, and `agy` integrations remain unchanged.

## Same-page eight-digit email sign-in

The consent page calls `signInWithOtp({email, options:{shouldCreateUser:false}})`, then `verifyOtp({email, token, type:'email'})` in the same tab. `authorization_id` stays in that tab's URL; successful sign-in reveals the existing consent screen, and only Approve redirects to the OAuth client. Existing gateway user/client allowlists are unchanged.

**Required hosted email template change:** a project owner/admin must open Supabase Dashboard → the Open Brain project → Authentication → Email Templates → Magic Link. Replace its body with `supabase/templates/magic_link.html`, which includes `{{ .Token }}` instead of a confirmation link. Suggested subject: `Your Open Brain sign-in code`. Save the template. This is hosted Auth configuration; deploying the page does not apply it. The builder supplies the exact template; the existing deployment owner applies it after release, or Tony applies these exact dashboard steps. No credentials belong in the template. Do not request Tony's retry until that setting and the page are verified.

The approved existing email account must already exist; sign-up remains disabled for code requests. The default resend interval is controlled by Supabase (normally 60 seconds). Invalid/expired codes show an error and grant no consent. Codes and sessions are not logged. The email remains fixed after a successful send so verification cannot accidentally use another address; reload the same authorization URL to change it.

**Single retry, once both page/template and Bee's MCP-header gateway fix are ready:** start Connect again from ChatGPT's existing Open Brain connection, enter the approved email, click Send eight-digit code, read the newest email, type its eight digits into the SAME authorization page, click Verify code, review the requested client/access, and click Approve. Do not open a magic link or copy the authorization URL into another tab. A stale request should be restarted from ChatGPT, not repaired by changing its authorization ID.

Mock verification runs the actual module script from both static and fallback Edge consent surfaces with synthetic OTP/session and authorization details; no real email is sent. A mock PASS does not prove hosted email delivery or template state.

Hosted Auth readback on 2026-10-20 confirms `auth.email.otp_length = 8`. Both UI surfaces validate exactly eight digits. The approved implementation follows that existing setting; do not change Auth configuration to six digits.

The consent client keeps its authenticated session in SDK memory within the current tab (`persistSession:false`). This avoids reliance on browser persistent storage and cross-tab session broadcasts during the same-page code flow. Reloading the authorization page requires signing in again; approval remains explicit.
