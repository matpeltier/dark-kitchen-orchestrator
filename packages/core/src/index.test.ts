import { describe, expect, it } from 'vitest';

import { createProjectId, createTaskId } from './index.js';
import type { Task } from './index.js';

describe('core bootstrap', () => {
  it('can represent a framework-neutral task', () => {
    const task: Task = {
      id: createTaskId('bootstrap'),
      projectId: createProjectId('project'),
      title: 'Bootstrap Dark Kitchen',
      status: 'active',
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
    };

    expect(task.status).toBe('active');
  });
});
