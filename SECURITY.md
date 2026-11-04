# Security Policy

Connect All handles private messages, calendars and optional model keys. Please do not open a public issue for a vulnerability.

Report vulnerabilities privately through **GitHub Security Advisories** (the repository's **Security → Report a vulnerability** tab). Include:

- affected version and platform
- reproduction steps or a minimal proof of concept
- impact (confidentiality / integrity / availability)

Please allow a reasonable window for a fix before public disclosure.

## Scope notes

- The relay only stores ciphertext and metadata; it is not expected to read message contents.
- The 8-digit SAS comparison is the human defence against a malicious relay replacing keys. A compromised endpoint or an unverified SAS is outside the protocol's guarantees.
- API keys are stored through the OS keychain when available; Linux systems without a keyring may fall back to a local file with a warning.
