# DeepSeek Harness adapter

`@dark-kitchen/harness-deepseek` is an optional native adapter for the official
[`@deepseek-ai/dsh`](https://github.com/deepseek-ai/deepseek-harness) package.
It is not installed by the core harness package.

Supported developer previews are pinned to `0.1.0-rc.7` and `0.1.0-rc.8`.
The adapter probes `dsh --version` before the first session and fails with a
typed compatibility error for another version.

The official headless profile currently accepts its job as a positional CLI
argument. Dark Kitchen never does that: it launches `dsh` with `shell: false`,
stores the prompt in a disposable Dark Kitchen payload artifact, and supplies a
transient `--patch` overlay that reads the referenced file. Prompt contents do
not enter argv, environment values, or process diagnostics.

The adapter does not edit `$DSH_HOME`, profiles, `cordis.patch.yml`, plugins,
skills, MCP settings, credentials, or model configuration. Set `dshHome` or
`profile` only to point at an existing setup. The current headless protocol is
one-shot, so the honest capability set contains active-run cancellation only;
resume, live instructions, and per-run model/plugin/skill/MCP changes are
rejected before launch.
