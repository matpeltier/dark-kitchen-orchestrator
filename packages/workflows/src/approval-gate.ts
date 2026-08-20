export interface WorkflowApprovalRequest {
  /** Stable across retries/resumes so a durable intervention can be reused. */
  readonly gateId: string;
  readonly kind: 'destructive-change-approval' | 'sensitive-change-approval';
  readonly summary: string;
  readonly details: string;
  readonly requestedActions: readonly string[];
  readonly taskContext?: Readonly<Record<string, unknown>>;
}

export type WorkflowApprovalResolution =
  | {
      readonly status: 'pending';
      readonly interventionId?: string;
    }
  | {
      readonly status: 'approved';
      readonly interventionId?: string;
      readonly resolvedBy?: string;
      readonly note?: string;
    }
  | {
      readonly status: 'rejected';
      readonly interventionId?: string;
      readonly resolvedBy?: string;
      readonly note?: string;
    };

/**
 * Host-owned durable approval boundary.
 *
 * `request` must be idempotent by `gateId`. A pending result causes the
 * workflow to stop with `WorkflowInterventionRequired`. After the host stores
 * a human resolution, rerunning with the same workflow run ID/journal replays
 * completed agent steps and asks the same gate again, which can then approve.
 */
export interface ResumableApprovalGate {
  request(request: WorkflowApprovalRequest): Promise<WorkflowApprovalResolution>;
}

export interface StructuredWorkflowIntervention {
  readonly status: 'intervention';
  readonly kind: WorkflowApprovalRequest['kind'];
  readonly gateId: string;
  readonly summary: string;
  readonly details: string;
  readonly interventionId?: string;
  readonly retryable: true;
}

export class WorkflowInterventionRequired extends Error {
  public readonly request: WorkflowApprovalRequest;
  public readonly outcome: StructuredWorkflowIntervention;

  public constructor(request: WorkflowApprovalRequest, interventionId?: string) {
    super(`Workflow requires approval at gate "${request.gateId}": ${request.summary}`);
    this.name = 'WorkflowInterventionRequired';
    this.request = request;
    this.outcome = {
      status: 'intervention',
      kind: request.kind,
      gateId: request.gateId,
      summary: request.summary,
      details: request.details,
      ...(interventionId ? { interventionId } : {}),
      retryable: true,
    };
  }
}

/** Fail closed unless the durable host gate explicitly approves. */
export async function requireWorkflowApproval(
  gate: ResumableApprovalGate,
  request: WorkflowApprovalRequest,
): Promise<Extract<WorkflowApprovalResolution, { status: 'approved' | 'rejected' }>> {
  const resolution = await gate.request(request);
  if (resolution.status === 'pending') {
    throw new WorkflowInterventionRequired(request, resolution.interventionId);
  }
  return resolution;
}
