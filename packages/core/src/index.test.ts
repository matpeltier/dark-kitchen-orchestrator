import { describe, expect, it } from 'vitest';

import type { Task } from './index.js';

describe('core bootstrap', () => {
  it('can represent a framework-neutral task', () => {
    const task: Task = { id: 'bootstrap', title: 'Bootstrap Dark Kitchen', status: 'active' };

    expect(task.status).toBe('active');
  });
});
