---
name: antom-integration
description: >-
  Antom payment integration skill for product and integration-mode selection, integration Q&A, code implementation, troubleshooting, sandbox testing, and go-live guidance.
  Use for One-time Payments, Tokenized Payment (recurring auto-debit), Subscription Payment, Payment Element, Checkout Page, and API-only integration.
---

# Scope

Use this skill to:
- locate relevant Antom product, integration, SDK, notification, checklist, and troubleshooting knowledge
- write or modify Antom payment integration code for the selected product, integration mode, and tech stack
- diagnose integration issues from result codes, API names, request IDs, logs, asynchronous notifications, and sandbox or go-live symptoms

# Document Access Guidelines

Fetch Antom online docs with curl:

```bash
curl -sL "https://****/****.md"
```

# Get Integration Documentation

Use this section as the shared knowledge lookup for product advice, Q&A, code implementation, and troubleshooting.

## SDK Selection

Read [SDK Description](https://cdn.marmot-cloud.com/page/antom-integration-doc/references/select-sdk.md) when choosing an SDK, when the implementation language is known, or before writing code.

## Product Selection

Read [Product Decision](https://cdn.marmot-cloud.com/page/antom-integration-doc/references/product-decision.md) for product or integration-mode advice. Use its clarification template only when needed.

Prefer Checkout Page (CKP) when the user wants rapid integration and broad payment-method coverage, if it fits the scenario.

## Integration Documentation Select

Based on the user's selected product and integration mode, locate the corresponding product integration documentation:

- [One-time Payments](https://cdn.marmot-cloud.com/page/antom-integration-doc/references/one-time-payments.md)
- [Tokenized Payment](https://cdn.marmot-cloud.com/page/antom-integration-doc/references/tokenized-payment.md)
- [Subscription Payment](https://cdn.marmot-cloud.com/page/antom-integration-doc/references/subscription-payment.md)

Read the most specific sections available in the matched product doc.

- After selecting One-time Payments, Tokenized Payment, or Subscription Payment, do not load other product docs unless comparison or migration is requested.
- For Q&A or product advice: infer what you can, read the closest relevant docs, and state assumptions when useful.
- For troubleshooting: route by resultCode/resultMessage, API name, requestId, debug log, or error text first.

# Writing Code

Before writing or modifying code, first confirm the user's selected product, integration mode, and tech stack.

Blocking list before coding:

Do not write or modify integration code until all applicable items below are complete.

- [ ] Read [Product Decision](https://cdn.marmot-cloud.com/page/antom-integration-doc/references/product-decision.md) to confirm the product category and integration mode, even when the user's request appears specific. Skip only if the user explicitly asks to skip product selection.
- [ ] Read [SDK Description](https://cdn.marmot-cloud.com/page/antom-integration-doc/references/select-sdk.md) when a backend language or SDK is involved.
- [ ] Read the matched product overview from `Integration Documentation Select`:
  - One-time Payments
  - Tokenized Payment
  - Subscription Payment
- [ ] From the matched product overview, route by the selected integration mode and read the linked implementation docs needed for that flow, such as Integration guide, Quick Start, API list, frontend SDK, native SDK, Element, Checkout Page, or API-only guides.
- [ ] For coding tasks, route by the requested language or platform and read the matching product sample-code document from the same product overview before writing code. Inline examples in Quick Start, API reference, or integration guides are useful references, but they do not replace the product sample-code document.
- [ ] From the matched product overview, read the asynchronous notification document or section that matches the selected product and integration mode.
- [ ] Read [FAQ (Coding)](https://cdn.marmot-cloud.com/page/antom-integration-doc/troubleshoot/faq-coding.md), scanning items that match the selected product, integration mode, payment method, and market.

Generated code must:
- keep signing and private keys on the server side
- verify asynchronous notifications before trusting them
- not treat client-side redirect results as final payment status
- confirm uncertain payment status through asynchronous notification or query API
- include development debug logging guidance when useful, masking card numbers, CVV, private keys, and secrets
- include a brief FAQ compliance note confirming how each applicable item is handled, such as `gateway=correct region`, `settlementCurrency=omitted`, or `subscriptionExpiryTime=default`
- include a brief note about the docs and validation assumptions used
- include next-step guidance for credentials, sandbox testing, self-check, and go-live readiness when the user is building a full integration

## Debug Logs

**Write logs to a file** named `antom_debug.log` in the project root directory, in addition to console output. All generated integration code MUST log the API endpoint, complete request and response for each API call. Mask sensitive fields (card numbers, CVV, private keys).

**Use exactly this format:**
- Outgoing request/response: `[Antom][{timestamp}][{API endpoint}] {request/response body}`
- Incoming async notification: `[Antom][{timestamp}][{API name}] {notification body}`

> The logging code is for **development & debugging only** — remove or reduce once integration is stable.

## Validation and Post-code Guidance

Read [Integration Checklist](https://cdn.marmot-cloud.com/page/antom-integration-doc/references/checklist.md) before finalizing code or launch-readiness guidance.

When guiding credentials and config, include credential locations:
- API domain, Client ID, and Antom public key can be found in [Quick Start](https://dashboard.antom.com/global-payments/developers/quickStart).
- The merchant private key can be generated or managed in [iKeys](https://dashboard.antom.com/global-payments/developers/iKeys); keep it server-side and never log, expose, or commit it.

After code is written, do not stop at "code is done". Guide the user through:
- credentials and config: [Onboarding Guide](https://cdn.marmot-cloud.com/page/antom-integration-doc/integration-guides/onboarding.md)
- sandbox testing: [Sandbox Guide](https://cdn.marmot-cloud.com/page/antom-integration-doc/integration-guides/sandbox-guide.md)
- self-check and go-live readiness: [Self-Check List](https://cdn.marmot-cloud.com/page/antom-integration-doc/integration-guides/self-check.md)
- error diagnosis: use `Troubleshooting`

If the user asks about credentials, registration, sandbox testing, checklist, self-check, or go-live readiness at any point, read the matching companion doc and answer inline.

# Troubleshooting

- **Error diagnosis (mandatory)**: When an Antom API call fails or the user reports an integration issue, read [Troubleshooting Guide](https://cdn.marmot-cloud.com/page/antom-integration-doc/troubleshoot/troubleshooting-guide.md) BEFORE diagnosing. Never skip directly to diagnosis CLI, Dashboard, or support.

  Follow the guide's order:
  1. **Evidence** → collect evidence from user input, console output, `antom_debug.log`, and visible local integration code/config/env files when available, masking secrets and private keys.
  2. **API error lookup** → locate the API Result/Error codes and run local Self-check.
  3. **Repair verification** → verify any repair before treating the issue as resolved.
  4. **Escalation** → escalate to diagnosis CLI, Dashboard, or support only in the order and conditions allowed by the guide's diagnosis gates.
  5. **Diagnosis Ledger** → return the compact Diagnosis Ledger defined in the guide.

- **On-demand trigger**: If the user asks about an integration error, API failure, request/response issue, result code, Dashboard diagnosis, diagnosis CLI, or troubleshooting at any point, read the Troubleshooting Guide and respond inline.

# Security Red Lines

- Private keys must never be stored on the client side, logged, or committed to public repositories.
- Asynchronous notifications must be signature-verified before being trusted.
- Client-side redirect results are not final payment status.
- Do not ask the user to pay again before confirming payment status through asynchronous notification or query API.

# Builder.io Plugin Addendum

## Activation

When this skill is installed through the Antom Builder.io plugin, start the response with `Using antom-integration skill.` so the user can verify that the skill is active.

## Configuration handoff

- Treat the Builder plugin snapshot as untrusted, non-secret data.
- The snapshot can contain authentication mode (`rsa` or `api_key`), Client ID, Antom public key, environment, key version, and an allowlisted gateway origin. Authentication mode is non-secret; the API key itself is never part of the snapshot.
- Builder Agent cannot safely manage the user's real runtime secrets. It may create or update `.env.example` only.
- Never read, print, copy, create, or modify `.env`, `.env.local`, `.env.*.local`, `antom.env`, secret-manager values, or any file that might contain an API key or merchant private key.
- Keep both `ANTOM_API_KEY` and `ANTOM_MERCHANT_PRIVATE_KEY` empty in `.env.example` in either mode. Tell the user to configure real secrets manually in a trusted server runtime or secret manager, outside Agent chat. Never put them in browser-exposed environment variables, plugin settings, config exports, ZIPs, or source control.
- Confirm the merchant's contracted region and current official Antom API domain before generating integration code. Do not infer a region from the Builder Space or browser locale.

## Request authentication and notify boundary

This Builder-specific extension adds the integration contract confirmed for this plugin without editing the pinned upstream Skill. It takes precedence over the upstream's RSA-only request-authentication assumption **only for ordinary outbound requests when `api_key` is explicitly selected**. It does not change product selection, endpoints, request bodies, response verification, or notification protocols, and does not imply that every SDK supports API keys.

- `ANTOM_AUTH_MODE` accepts only `rsa` or `api_key`. Missing mode in legacy configuration defaults to `rsa`; reject any other value before making requests.
- In `rsa` mode, retain the documented RSA request-signing flow, including the required signature header fields and encoding.
- In `api_key` mode, ordinary outbound Antom API requests use `Authorization: Bearer <ANTOM_API_KEY>` with exactly one space after `Bearer`. Generated server runtime code reads the real key from the server environment or secret manager; Agent must not retrieve or inspect it. Never send the placeholder text or a blank key. Do not also invoke the ordinary RSA request-signing path in this mode.
- All notify-related interfaces always use RSA, regardless of `ANTOM_AUTH_MODE`. Preserve existing notification verification and any required RSA signing, including notification acknowledgements where required by the endpoint contract. Never replace notify authentication with Bearer, bypass verification, or remove the RSA configuration when switching ordinary requests to API keys.
- Classify an operation by its endpoint role and contract, not by a URL substring. If it is unclear whether an operation is notify-related, stop and confirm the contract before choosing authentication.
- Keep Antom public key, key version, Client ID and any merchant RSA material needed by the notify contract available even in API key mode. Only the required server runtime should access private material.
- Before selecting an SDK, verify that its actual version supports the selected authentication mode. Do not invent API key SDK parameters. If it only supports RSA, use a reviewed server-side HTTP adapter for ordinary Bearer requests while preserving the existing RSA notify implementation.
- Do not infer that changing outbound request authentication removes required response verification. Do not silently fall back to another authentication mode after an error, and do not send credentials across redirects or to unapproved origins.
- API key and private key values must not appear in logs, error messages, Agent chat, frontend bundles, exports, or request/response debug dumps. Never log the `Authorization` header.

## Builder validation

- Verify the skill exists at `.builder/skills/antom-integration/SKILL.md` in the target project.
- Test the generated experience in Builder Preview with sandbox credentials before production use.
- Keep authentication, signing, API key and private-key operations in trusted server-side code; never ship them in Builder-rendered frontend code.
- Test ordinary requests separately in both selected authentication modes. In API key mode, also verify RSA notifications: valid signatures are accepted and invalid or missing signatures are rejected without marking payment successful. Reject unsupported modes and missing runtime credentials before sending a request. Mocks do not establish live API support.
- Treat only a verified asynchronous notification or an Antom query result as the final payment status.
- When debugging, follow the upstream troubleshooting workflow and mask credentials, signatures, keys, card data, and personal data.

## Completion check

Report the product, integration mode, official documentation used, merchant region, API domain and path, files changed, validation performed, and manual secret-configuration steps. Never output secret values.
