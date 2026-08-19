# Notices

This package contains code adapted from:

**codex-dynamic-workflows**

- Source: https://github.com/six-ddc/codex-dynamic-workflows
- License: MIT
- Author: six-ddc

The workflow engine concepts (workflow parsing/runtime, agent(), parallel execution, pipelines, nested workflows, phases, retries, concurrency limits, progress events, journals, and stable agent-call keys) were inspired by and partially adapted from this upstream project.

Significant changes made in Dark Kitchen's adaptation:

- Removed provider enums (codex | gemini | pi) and all OpenAI/Codex SDK dependencies.
- Replaced provider-specific types with a generic `HarnessRunner`/`RoleResolver` contract.
- Added mandatory semantic `role` requirement for every `agent()` call; no fallback to labels or arrival-order IDs.
- Derived deterministic call keys from logical branch/call position to prevent key collisions across sequential or parallel calls of the same child workflow.
- Added run-level cancellation covering the complete workflow execution, including code outside engine primitives.
- Added TypeScript strict-mode compliance and ESM-only module format.

MIT License

Copyright (c) six-ddc

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
