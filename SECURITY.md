# Security Policy

## Supported Versions

Dark Kitchen is under active development. Security fixes are applied to the latest version only.

## Trust Model

| Component                                                     | Trust Level                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| Core packages (`@dark-kitchen/core`, `workflow-engine`, etc.) | Fully trusted                                                   |
| Tracker/SCM adapters                                          | Trusted; run in the Dark Kitchen process                        |
| Harness plugins (`native-process`, `acp`, `dsh`)              | Trusted after explicit allowlisting                             |
| Third-party harness adapters                                  | Require explicit `allowedPlugins` allowlist entry               |
| Task bodies/tracker content                                   | Untrusted; never executed as code                               |
| Workflow files (`.dark-kitchen/workflows/*.ts`)               | Trusted; reviewed by project owners                             |
| MCP clients                                                   | Trusted to call DK services; not trusted to bypass policy gates |

## Secret Handling

- Credentials are never stored in `.dark-kitchen/config.yaml`, SQLite, logs, or event payloads
- All config token fields expect environment variable names (e.g. `tokenEnv: GITHUB_TOKEN`), not values
- Dark Kitchen applies automatic secret redaction to log output
- `ConfigValidationError` is thrown when inline secrets are detected in config

## Plugin Security

- Third-party harness adapters must be explicitly allowlisted before loading
- Use `allowlistPlugin('@my-scope/my-harness')` or the `allowedPlugins` config field
- Unapproved plugins throw `UnauthorizedPluginError`

## Destructive Actions

Actions with irreversible effects require explicit approval through the intervention system:

- Capability installation: requires `capability.install` approval
- Git force-push: requires `git.force-push` approval
- Other destructive actions are auto-approved by default policy (configurable)

## Remote Access

- MCP server defaults to stdio transport (local-only)
- HTTP/remote MCP exposure requires explicit authentication configuration
- Remote execution nodes validate identities and API keys

## Vulnerability Reporting

Please report security vulnerabilities by emailing the maintainer directly rather than opening a public GitHub issue. Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact

We will respond within 72 hours and coordinate disclosure.
