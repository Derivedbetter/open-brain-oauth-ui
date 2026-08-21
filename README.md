# Open Brain web gateway

OAuth-protected remote MCP gateway for Tony's Gemini Spark and Perplexity web clients. It forwards approved calls to the existing vanilla Open Brain and never creates another brain.

## Boundaries

- Open Brain is operational memory, not Continuity, COTA, Current-State Tracker, or owner-acceptance authority.
- No automatic chat capture. Capture tools are for explicit requests only.
- The vanilla Open Brain repository and Edge Function remain unchanged.
- Browser clients receive short-lived OAuth tokens, never the long-lived Open Brain access key.
- OAuth tokens are validated and then terminated at this gateway; they are not passed to the upstream Open Brain.

## Components

- `open-brain-web-gateway`: OAuth-protected Streamable HTTP MCP relay with client/user allowlists, exact and summary aliases, and authoritative post-write receipts.
- `docs/`: GitHub Pages email-link sign-in and OAuth consent UI, plus privacy and terms pages.
- `open-brain-oauth-ui`: deployable source retained as a fallback for a future custom Supabase domain; the default Supabase Functions domain intentionally rewrites HTML to plain text.

## Required live configuration

1. Supabase OAuth 2.1 Server enabled with authorization path `/oauth/consent`.
2. Auth Site URL: `https://derivedbetter.github.io/open-brain-oauth-ui`.
3. Authorization path: `/oauth/consent/` and redirect allowlist includes `https://derivedbetter.github.io/open-brain-oauth-ui/**`.
4. Two pre-registered confidential clients: Gemini Spark and Perplexity.
5. Edge secrets:
   - `OPEN_BRAIN_ALLOWED_EMAILS=<approved-email>`
   - `OPEN_BRAIN_OAUTH_CLIENT_IDS=<gemini-client-id>,<perplexity-client-id>`
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
- unauthenticated `POST /functions/v1/open-brain-web-gateway` returns `401` and an OAuth `WWW-Authenticate` challenge.
- invalid user, client, issuer, audience, and expired tokens fail closed without an upstream call.

## Rollback

Revoke the affected OAuth client, disable the connector in Gemini or Perplexity, disable Supabase OAuth Server if no clients remain, and delete only the two gateway Edge Functions. Existing Open Brain data and the ChatGPT, Codex, and `agy` integrations remain unchanged.
