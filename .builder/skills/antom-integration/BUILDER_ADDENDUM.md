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
