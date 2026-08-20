# Security Policy

## Supported Versions

Dark Kitchen is under active development. Security fixes are applied to the latest version only.

## Trust Model

| Component                                                     | Trust Level                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| Core packages (`@dark-kitchen/core`, `workflow-engine`, etc.) | Fully trusted                                                   |
| Tracker/SCM adapters                                          | Trusted; run in the Dark Kitchen process                        |
| Harness plugins (`native-process`, `acp`, `dsh`)              | Trusted after explicit allowlisting                             |
| Third-party harness adapters                                  | Require explicit process-local allowlisting before import       |
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
- Use `allowlistPlugin('@my-scope/my-harness')` in trusted bootstrap code before loading it
- Unapproved plugins throw `UnauthorizedPluginError`

## Destructive Actions

The default policy classifies these actions as requiring approval:

- Capability installation: requires `capability.install` approval
- Git force-push: requires `git.force-push` approval
- Other destructive actions are classified separately by the policy module. Callers must enforce the policy before executing them.

## Remote Access

- The daemon binds its MCP HTTP server to loopback by default. Do not expose it through a proxy without adding authentication and TLS at that boundary.
- Remote execution-node support is experimental. API-key headers are supported, but the client does not itself prove node identity or enforce TLS.

## Vulnerability Reporting

Please use the repository's private [GitHub Security Advisory form](https://github.com/matpeltier/dark-kitchen-orchestrator/security/advisories/new) rather than opening a public issue. Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact

We will respond within 72 hours and coordinate disclosure.
