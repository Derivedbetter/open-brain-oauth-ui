# OAuth Bot client policy (source candidate)

Goal: `c2bf0def-17eb-45fa-87fe-ec2c258df503`.

The existing issuer, user, email, audience, expiry and route client allowlists remain mandatory. An additional server-owned `OPEN_BRAIN_BOT_CLIENT_POLICIES` JSON object binds an authenticated client ID to an exact Bot actor. It is configuration in the existing gateway, not a provisioning registry or a new credential. Example with synthetic IDs only:

```json
{"synthetic-oauth-client":{"actor":"grok/bot/corty","phase":"readonly","recipients":[]}}
```

To begin on the main gateway URL, the client must also be in the existing main-route OAuth allowlist. The policy still restricts that client to the eight existing read tools. The read-only URL independently enforces those same eight reads. `check_messages` is bound to the configured Bot mailbox. A supplied foreign actor/sender/source_actor or mailbox is refused. No caller identity header is trusted or forwarded.

After the owner of the integration has actual Corty phone OAuth read evidence, a separately authorized configuration change may promote this same client to `own_mail_receipt`, with an explicit outbound recipient list. This permits only `consume_message` for its own mailbox, informational `send_message` from its own sender to those recipients, and the existing `write_work_receipt` with its own source actor. It does not permit review requests, task handoffs, generic capture, authority/admin tools, or Tony-origin memory. Existing work receipt provenance remains agent_generated. The existing returned ID and `fetch` provide the required actual readback. The read-only URL never permits these writes. The phase limits tools and identity; it is not an exactly-once or one-write quota. The reviewed proof procedure, not a newly invented counter, bounds the first meaningful write.

The current core `fetchMessagingRecord` formatter emits `metadata.storage: messaging`, `record_kind: message|receipt`, `type: internal_message|internal_message_receipt` and `recipient`; messages also carry `sender`. Exact fetch only returns such protected records addressed to or authored by this Bot. Protected hints with an unknown or incomplete shape fail closed. Ordinary thought documents retain their existing `id`, `text`, `metadata` shape. Server-time text and existing error wrappers remain readable; unknown success text or structured duplicate payloads are refused. JSON and SSE bookkeeping remains intact. This guard runs after authenticated upstream retrieval and before returning any body to the Bot; a refused fetch may still produce the existing core fetch audit entry.

Unconfigured OAuth clients retain their existing behavior. Malformed policy configuration fails closed with 503 for authenticated traffic; validate it before deployment. Removing a policy would restore that client's existing route rights, so operator configuration changes must retain the policy binding. The mapping binds an OAuth client, not a cryptographic Bot instance: Grok's account-wide app sharing remains a provider limitation. Shared memory read tools retain their existing scope; this is mailbox separation, not a new memory tenant.

Source-only candidate: no live configuration, OAuth sign-in, key, Bot, Routine, checker, production deployment or account activation is performed here. Root owns actual read, phase promotion, meaningful receipt write/readback, same-Bot wake and response, independent review and owner acceptance.
