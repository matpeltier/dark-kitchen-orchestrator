import { describe, expect, it } from 'vitest';
import type { AgentControlService, AgentInspection } from '@dark-kitchen/runtime';
import type { AgentSession } from '@dark-kitchen/core';
import { createAgentSessionId } from '@dark-kitchen/core';
import { findPmSession, resolutionAck, routeFreeChatToPm } from './channel-fallback.js';

function session(id: string, state: AgentSession['state'], updatedAt: string): AgentSession {
  return {
    id: createAgentSessionId(id),
    runId: `run-${id}` as AgentSession['runId'],
    taskId: `task-${id}` as AgentSession['taskId'],
    executionNodeId: `exec-${id}` as AgentSession['executionNodeId'],
    workspaceId: `ws-${id}` as AgentSession['workspaceId'],
    state,
    createdAt: updatedAt,
    updatedAt,
  };
}

function inspection(
  partial: Omit<Partial<AgentInspection>, 'session'> & { session: AgentSession },
): AgentInspection {
  return {
    lastActivityAt: partial.session.updatedAt,
    controls: {
      sendInstruction: true,
      interruptAndSend: false,
      stop: false,
      restart: false,
      retry: false,
      switchProfile: false,
    },
    ...partial,
  } as AgentInspection;
}

function fakeControls(agents: readonly AgentInspection[]): {
  controls: AgentControlService;
  instructions: Array<{ sessionId: string; instruction: string }>;
} {
  const instructions: Array<{ sessionId: string; instruction: string }> = [];
  const controls = {
    listAgents: async () => agents,
    sendInstruction: async (sessionId: never, instruction: string) => {
      instructions.push({ sessionId: String(sessionId), instruction });
    },
  } as unknown as AgentControlService;
  return { controls, instructions };
}

describe('findPmSession', () => {
  it('prefers the active PM-role session over other live sessions', async () => {
    const worker = inspection({
      session: session('worker-1', 'running', '2026-01-01T10:00:00Z'),
      roleId: 'implementer',
    });
    const pm = inspection({
      session: session('pm-1', 'running', '2026-01-01T09:00:00Z'),
      roleId: 'chatgpt-pm',
    });
    const { controls } = fakeControls([worker, pm]);
    expect((await findPmSession(controls))?.session.id).toBe(pm.session.id);
  });

  it('falls back to the most recent instructable session without a PM role', async () => {
    const older = inspection({
      session: session('older', 'waiting', '2026-01-01T08:00:00Z'),
      roleId: 'reviewer',
    });
    const newer = inspection({
      session: session('newer', 'running', '2026-01-01T12:00:00Z'),
    });
    const terminal = inspection({
      session: session('done', 'completed', '2026-01-01T13:00:00Z'),
      controls: {
        sendInstruction: false,
        interruptAndSend: false,
        stop: false,
        restart: true,
        retry: true,
        switchProfile: false,
      },
    });
    const { controls } = fakeControls([older, terminal, newer]);
    expect((await findPmSession(controls))?.session.id).toBe(newer.session.id);
  });

  it('returns undefined when no session can receive instructions', async () => {
    const done = inspection({
      session: session('done', 'failed', '2026-01-01T13:00:00Z'),
      controls: {
        sendInstruction: false,
        interruptAndSend: false,
        stop: false,
        restart: true,
        retry: true,
        switchProfile: false,
      },
    });
    const { controls } = fakeControls([done]);
    expect(await findPmSession(controls)).toBeUndefined();
  });
});

describe('routeFreeChatToPm', () => {
  it('forwards the message to the PM session and acknowledges on the channel', async () => {
    const pm = inspection({
      session: session('pm-1', 'running', '2026-01-01T09:00:00Z'),
      roleId: 'pm',
    });
    const { controls, instructions } = fakeControls([pm]);
    const sent: string[] = [];
    await routeFreeChatToPm({
      body: 'what are you working on?',
      senderId: '424242',
      agentControls: controls,
      notify: async (body) => {
        sent.push(body);
      },
      log: () => {},
    });
    expect(instructions).toHaveLength(1);
    expect(instructions[0]?.sessionId).toBe(String(pm.session.id));
    expect(instructions[0]?.instruction).toContain('what are you working on?');
    expect(instructions[0]?.instruction).toContain('424242');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/transmis au PM/i);
  });

  it('answers on the channel when there is no active session', async () => {
    const { controls } = fakeControls([]);
    const sent: string[] = [];
    await routeFreeChatToPm({
      body: 'hello?',
      agentControls: controls,
      notify: async (body) => {
        sent.push(body);
      },
      log: () => {},
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/aucun projet actif/i);
  });

  it('redacts secrets in the forwarded instruction', async () => {
    const pm = inspection({ session: session('pm-1', 'running', '2026-01-01T09:00:00Z') });
    const { controls, instructions } = fakeControls([pm]);
    await routeFreeChatToPm({
      body: 'use token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 please',
      agentControls: controls,
      notify: async () => {},
      log: () => {},
    });
    expect(instructions[0]?.instruction).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
    expect(instructions[0]?.instruction).toContain('[REDACTED]');
  });

  it('notifies the channel when forwarding fails', async () => {
    const pm = inspection({ session: session('pm-1', 'running', '2026-01-01T09:00:00Z') });
    const controls = {
      listAgents: async () => [pm],
      sendInstruction: async () => {
        throw new Error('runtime gone');
      },
    } as unknown as AgentControlService;
    const sent: string[] = [];
    let warned = '';
    await routeFreeChatToPm({
      body: 'hello',
      agentControls: controls,
      notify: async (body) => {
        sent.push(body);
      },
      log: (_level, message) => {
        warned = message;
      },
    });
    expect(sent[0]).toMatch(/pas pu être transmis/i);
    expect(warned).toContain('runtime gone');
  });
});

describe('resolutionAck', () => {
  it('produces a distinct confirmation per action type', () => {
    expect(resolutionAck('retry', 'task-1')).toMatch(/retry/i);
    expect(resolutionAck('stop', 'task-1')).toMatch(/stop/i);
    expect(resolutionAck('approve', 'task-1')).toMatch(/approuv/i);
    expect(resolutionAck('free-text', 'task-1')).toMatch(/transmise/i);
    expect(resolutionAck('switch-harness', 'task-1')).toMatch(/harness/i);
    for (const action of ['retry', 'stop', 'approve', 'free-text', 'switch-harness'] as const) {
      expect(resolutionAck(action, '42-task')).toContain('42-task');
    }
  });
});
