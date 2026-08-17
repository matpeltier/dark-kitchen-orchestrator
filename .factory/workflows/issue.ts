export const meta = {
  name: "dark-kitchen-issue",
  description: "Run a configurable role-based workflow for one GitHub issue.",
  whenToUse: "For a Dark Kitchen AI-managed GitHub issue.",
  phases: [
    { title: "Architecture / design" },
    { title: "Implementation" },
    { title: "Independent review" },
    { title: "Fix and reverify" },
  ],
};

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type RoleConfig = {
  provider: string;
  model?: string;
  prompt?: string;
  agentType?: string;
  skills?: string[];
  mcp?: string[];
};

type WorkflowProfile = {
  roles: string[];
  plan?: "auto" | "always" | "never";
  prompt?: string;
  planRole?: string;
  implementationRole?: string;
  reviewRole?: string;
  fixRole?: string;
};

const configPath = process.env.FACTORY_CONFIG_PATH ?? path.join(process.cwd(), ".factory", "config.json");
const factoryConfig = JSON.parse(await readFile(configPath, "utf8")) as {
  roles: Record<string, RoleConfig>;
  workflows: Record<string, WorkflowProfile>;
};

// codex-dynamic-workflows injects agent(), phase(), and args into this script.
const issue = args as {
  number: number;
  title: string;
  body: string;
  labels: string[];
  resultPath?: string;
};

const IMPLEMENTATION_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["success", "needs_human"] },
    summary: { type: "string" }, question: { type: "string" },
    category: { type: "string" }, recommendation: { type: "string" },
    tests: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary", "tests"],
};

const REVIEW_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    hasBlockingFindings: { type: "boolean" }, summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["hasBlockingFindings", "summary", "findings"],
};

const FIX_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["fixed", "needs_human"] },
    summary: { type: "string" }, question: { type: "string" },
    category: { type: "string" }, recommendation: { type: "string" },
  },
  required: ["status", "summary"],
};

function issueProfileName(): string {
  const section = issue.body.match(/(?:^|\n)##\s*Dark Kitchen workflow\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] ?? "";
  return section.match(/^\s*profile\s*:\s*([a-z0-9][a-z0-9_-]*)\s*$/im)?.[1] ?? "default";
}

function roleFor(profile: WorkflowProfile, roleName: string | undefined): { name: string; config: RoleConfig } | undefined {
  if (!roleName) return undefined;
  if (!profile.roles.includes(roleName)) throw new Error(`Workflow profile does not allow role ${roleName}`);
  const config = factoryConfig.roles[roleName];
  if (!config) throw new Error(`Workflow profile references missing role ${roleName}`);
  return { name: roleName, config };
}

async function roleInstructions(role: { name: string; config: RoleConfig }): Promise<string> {
  const sections: string[] = [];
  if (role.config.prompt) sections.push(`Role instructions for ${role.name}:\n${role.config.prompt}`);
  const missingSkills: string[] = [];
  for (const skill of role.config.skills ?? []) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(skill) || skill.includes("..")) {
      missingSkills.push(`${skill} (unsafe skill name)`);
      continue;
    }
    const candidates = [
      path.join(process.cwd(), ".factory", "skills", skill, "SKILL.md"),
      path.join(process.cwd(), "skills", skill, "SKILL.md"),
      path.join(process.cwd(), ".agents", "skills", skill, "SKILL.md"),
      path.join(process.cwd(), ".codex", "skills", skill, "SKILL.md"),
    ];
    let content: string | undefined;
    for (const candidate of candidates) {
      try {
        content = await readFile(candidate, "utf8");
        break;
      } catch {
        // Try the next project-local skill directory.
      }
    }
    if (!content) missingSkills.push(skill);
    else sections.push(`Skill ${skill}:\n${content.slice(0, 20000)}`);
  }
  if (missingSkills.length) throw new Error(`Role ${role.name} requires unavailable skills: ${missingSkills.join(", ")}`);
  if (role.config.mcp?.length) {
    sections.push(`MCP servers requested for this role: ${role.config.mcp.join(", ")}. Use them only if they are actually exposed in this session; never claim access that is not available.`);
  }
  return sections.join("\n\n");
}

async function runRole(
  role: { name: string; config: RoleConfig },
  prompt: string,
  phaseName: string,
  schema: unknown,
): Promise<any> {
  const instructions = await roleInstructions(role);
  return agent(
    `${instructions}\n\n${prompt}`,
    {
      label: role.name,
      phase: phaseName,
      provider: role.config.provider,
      ...(role.config.model ? { model: role.config.model } : {}),
      ...(role.config.agentType ? { agentType: role.config.agentType } : {}),
      schema,
    },
  );
}

function warrantsArchitecture(): boolean {
  return /architecture|design|schema|migration|refactor|integration|api|database/i.test(`${issue.title}\n${issue.body}`)
    || issue.body.length > 900;
}

async function save(result: unknown): Promise<unknown> {
  const resultPath = issue.resultPath ?? path.join(process.cwd(), ".factory", "runtime", String(issue.number), "result.json");
  await mkdir(path.dirname(resultPath), { recursive: true });
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  return result;
}

let finalResult: any;
try {
  const profileName = issueProfileName();
  const profile = factoryConfig.workflows[profileName];
  if (!profile) {
    finalResult = {
      status: "needs_human",
      category: "requirement_ambiguity",
      summary: `Issue requests unknown Dark Kitchen workflow profile: ${profileName}.`,
      question: `Should this issue use one of the configured profiles: ${Object.keys(factoryConfig.workflows).join(", ")}?`,
      recommendation: "Add or correct the workflow profile before retrying.",
      evidence: [`The issue declared profile: ${profileName}`],
    };
  }

  if (!finalResult) {
    const planRole = roleFor(profile!, profile!.planRole);
    const implementationRole = roleFor(profile!, profile!.implementationRole);
    const reviewRole = roleFor(profile!, profile!.reviewRole);
    const fixRole = roleFor(profile!, profile!.fixRole);
    if (!implementationRole) throw new Error(`Workflow profile ${profileName} has no implementationRole`);

    let architecture = profile!.prompt || "No separate architecture phase was needed for this issue.";
    const shouldPlan = Boolean(planRole) && profile!.plan !== "never" && (profile!.plan === "always" || warrantsArchitecture());
    if (shouldPlan && planRole) {
      phase("Architecture / design");
      const plan = await runRole(
        planRole,
        `Read AGENTS.md and issue #${issue.number}: ${issue.title}\n\n${issue.body}\n\nPlan the smallest implementation that satisfies the stated acceptance criteria. Do not invent product requirements. If materially ambiguous or impossible, return a human blocker with a concrete question.`,
        "Architecture / design",
        IMPLEMENTATION_SCHEMA,
      );
      if (!plan) {
        finalResult = { status: "failed", summary: "The planning role returned no structured result.", attempts: ["Planning role returned null after retries."] };
      } else if (plan.status === "needs_human") {
        finalResult = { status: "needs_human", category: plan.category, summary: plan.summary, question: plan.question, recommendation: plan.recommendation, evidence: [] };
      } else {
        architecture = plan.summary;
      }
    }

    if (!finalResult) {
      phase("Implementation");
      const implementation = await runRole(
        implementationRole,
        `You are the implementation owner for GitHub issue #${issue.number}: ${issue.title}.\n\nIssue body and acceptance criteria:\n${issue.body}\n\nArchitecture/design context:\n${architecture}\n\nRead AGENTS.md and inspect the repository. Implement only this issue. Run relevant tests, lint, and typecheck where configured. Do not change product requirements, launch other issues, or ask about routine coding/debugging choices. Before reporting success, inspect the final diff and commit meaningful changes on the current branch. If a genuinely ambiguous/impossible requirement, missing credential, destructive approval, or repeated failure blocks the work, return needs_human with a precise question and evidence.`,
        "Implementation",
        IMPLEMENTATION_SCHEMA,
      );
      if (!implementation) {
        finalResult = { status: "failed", summary: "The implementation role returned no structured result.", attempts: ["Implementation role returned null after retries."] };
      } else if (implementation.status === "needs_human") {
        finalResult = { status: "needs_human", category: implementation.category, summary: implementation.summary, question: implementation.question, recommendation: implementation.recommendation, evidence: implementation.tests };
      } else {
        let reviewSummary = reviewRole ? "No blocking review findings." : "No review role configured.";
        let tests = implementation.tests;
        let unresolved: string[] = [];
        for (let loop = 0; reviewRole && loop < 2; loop += 1) {
          phase("Independent review");
          const review = await runRole(
            reviewRole,
            `Independently review issue #${issue.number} and the current worktree. Read the issue, AGENTS.md, git diff, committed changes, and test results. Check every acceptance criterion, correctness, regressions, and missing tests. Do not rewrite code in this review session. Return only actionable blocking findings.`,
            "Independent review",
            REVIEW_SCHEMA,
          );
          if (!review) {
            finalResult = { status: "failed", summary: "The review role returned no structured result.", attempts: ["Review role returned null after retries."] };
            break;
          }
          reviewSummary = review.summary;
          unresolved = review.findings;
          if (!review.hasBlockingFindings) break;
          if (!fixRole) {
            finalResult = { status: "needs_human", category: "repeated_failure", summary: "Blocking review findings exist but this workflow has no fix role.", question: "Should a fixer role be added or should the findings be resolved manually?", recommendation: "Configure fixRole for this workflow profile.", evidence: review.findings };
            break;
          }
          phase("Fix and reverify");
          const fixed = await runRole(
            fixRole,
            `Fix the blocking review findings for issue #${issue.number}. Findings:\n- ${review.findings.join("\n- ")}\n\nMake the smallest correct changes, rerun relevant tests, inspect the diff, and commit the fix. Do not ask about routine debugging. If a finding exposes a real product blocker, return needs_human.`,
            "Fix and reverify",
            FIX_SCHEMA,
          );
          if (!fixed) {
            finalResult = { status: "failed", summary: "The fix role returned no structured result.", attempts: ["Fix role returned null after retries."] };
            break;
          }
          if (fixed.status === "needs_human") {
            finalResult = { status: "needs_human", category: fixed.category, summary: fixed.summary, question: fixed.question, recommendation: fixed.recommendation, evidence: review.findings };
            break;
          }
          tests = [...tests, fixed.summary];
          if (loop === 1) {
            finalResult = { status: "needs_human", category: "repeated_failure", summary: "The independent review still has blocking findings after two fix loops.", question: "How should the remaining review findings be resolved?", recommendation: "Review the preserved worktree and choose the intended behavior.", evidence: unresolved };
          }
        }
        if (!finalResult) finalResult = { status: "success", summary: implementation.summary, tests, reviewSummary };
      }
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  finalResult = /requires unavailable skills|unsafe skill name/i.test(message)
    ? { status: "needs_human", category: "missing_access", summary: message, question: "Should the missing role skill be installed or removed from this workflow profile?", recommendation: "Install the named skill in the project and retry the issue.", evidence: [] }
    : { status: "failed", summary: message, attempts: ["Workflow orchestration or an agent call failed."] };
}

await save(finalResult);
finalResult;
