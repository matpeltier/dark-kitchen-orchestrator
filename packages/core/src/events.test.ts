import { describe, expect, it } from 'vitest';

import { createAgentSessionId, createEventId } from './index.js';
import type { AgentSessionCompletedEvent, AgentSessionStateChangedEvent } from './index.js';

const agentSessionId = createAgentSessionId('agent-1');
const timestamp = '2026-08-17T00:00:00.000Z';

describe('agent session events', () => {
  it('reserves agent.completed for terminal states', () => {
    const completed: AgentSessionCompletedEvent = {
      id: createEventId('event-1'),
      type: 'agent.completed',
      occurredAt: timestamp,
      payload: { agentSessionId, state: 'completed' },
    };
    const interrupted: AgentSessionStateChangedEvent = {
      id: createEventId('event-2'),
      type: 'agent.state-changed',
      occurredAt: timestamp,
      payload: { agentSessionId, previousState: 'running', state: 'interrupted' },
    };

    expect(completed.payload.state).toBe('completed');
    expect(interrupted.payload.state).toBe('interrupted');

    const invalidCompleted: AgentSessionCompletedEvent = {
      id: createEventId('event-3'),
      type: 'agent.completed',
      occurredAt: timestamp,
      // @ts-expect-error Interrupted sessions remain resumable and are not completed.
      payload: { agentSessionId, state: 'interrupted' },
    };
    expect(invalidCompleted).toBeDefined();
  });
});
