/**
 * Free-form chat fallback for channel messages that do not resolve to a
 * pending intervention.
 *
 * Routes the human's message to the active PM agent session (or the most
 * recent instructable session) and acknowledges the outcome on the origin
 * channel. All outbound bodies are redacted before delivery.
 */

import { redactSensitive } from '@dark-kitchen/runtime';
import type { AgentControlService, AgentInspection } from '@dark-kitchen/runtime';
import type { ResolutionAction } from '@dark-kitchen/runtime';

type InstructableControls = Pick<AgentControlService, 'listAgents' | 'sendInstruction'>;

const PM_ROLE_PATTERN = /(?:^|[-_])pm(?:[-_]|$)/i;

/** Pick the session that should receive free-form chat: PM first, then recency. */
export async function findPmSession(
  agentControls: InstructableControls,
): Promise<AgentInspection | undefined> {
  const agents = await agentControls.listAgents();
  const instructable = agents.filter((agent) => agent.controls.sendInstruction);
  if (instructable.length === 0) return undefined;
  const byRecency = (left: AgentInspection, right: AgentInspection): number =>
    right.lastActivityAt.localeCompare(left.lastActivityAt);
  const pm = instructable
    .filter((agent) => agent.roleId !== undefined && PM_ROLE_PATTERN.test(agent.roleId))
    .sort(byRecency)[0];
  if (pm) return pm;
  return [...instructable].sort(byRecency)[0];
}

/** Short per-action confirmation sent back to the human's channel. */
export function resolutionAck(action: ResolutionAction, targetId: string): string {
  switch (action) {
    case 'retry':
      return `✅ Retry relancé sur ${targetId}`;
    case 'stop':
      return `⏹️ Stop — ${targetId} est bloqué`;
    case 'approve':
      return `✅ Approuvé — reprise de ${targetId}`;
    case 'switch-harness':
      return `🔁 Harness relancé sur le nouveau profil pour ${targetId}`;
    case 'free-text':
      return `📨 Réponse transmise à ${targetId}`;
  }
}

export interface RouteFreeChatInput {
  readonly body: string;
  readonly senderId?: string;
  readonly agentControls?: InstructableControls;
  readonly notify: (body: string) => Promise<void>;
  readonly log: (level: 'info' | 'warn', message: string) => void;
}

/**
 * Deliver a free-form channel message to the active PM session. Always answers
 * on the channel (ack, no-active-project notice, or failure notice) so the
 * human is never left without feedback.
 */
export async function routeFreeChatToPm(input: RouteFreeChatInput): Promise<void> {
  const NO_ACTIVE_PROJECT =
    '🍳 Dark Kitchen — aucun projet actif : il n’y a pas de session d’agent à qui transmettre votre message. Démarrez un projet ou répondez à une intervention ouverte.';
  if (!input.agentControls) {
    await input.notify(NO_ACTIVE_PROJECT);
    return;
  }
  let pm: AgentInspection | undefined;
  try {
    pm = await findPmSession(input.agentControls);
  } catch (error) {
    input.log('warn', `Free-chat routing could not list agents: ${String(error)}`);
  }
  if (!pm) {
    await input.notify(NO_ACTIVE_PROJECT);
    return;
  }

  const sender = input.senderId ? redactSensitive(input.senderId) : 'propriétaire du canal';
  const instruction = redactSensitive(
    `[Message du canal (de ${sender})]\n\n${input.body.trim()}\n\nRéponds directement à cette personne si elle attend une réponse.`,
  );
  try {
    await input.agentControls.sendInstruction(pm.session.id, instruction);
  } catch (error) {
    input.log('warn', `Free-chat forwarding to ${String(pm.session.id)} failed: ${String(error)}`);
    await input.notify(
      `⚠️ Ton message n’a pas pu être transmis au PM : ${redactSensitive(String(error instanceof Error ? error.message : error))}`,
    );
    return;
  }
  input.log('info', `Free-chat message forwarded to PM session ${String(pm.session.id)}`);
  await input.notify('📨 Message transmis au PM.');
}
