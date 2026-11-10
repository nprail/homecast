import type { Database } from '../db/index.js';
import { now } from '../util/misc.js';

export interface AuditInput {
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  target?: string | null;
  targetLabel?: string | null;
  ip?: string | null;
  detail?: string | null;
}

export class AuditService {
  constructor(private db: Database) {}

  log(input: AuditInput): void {
    let actorName = input.actorName ?? null;
    if (!actorName && input.actorId) actorName = this.db.users.get(input.actorId)?.username ?? null;
    this.db.auditLog.insert({
      at: now(),
      actorId: input.actorId ?? null,
      actorName,
      action: input.action,
      target: input.target ?? null,
      targetLabel: input.targetLabel ?? null,
      ip: input.ip ?? null,
      detail: input.detail ?? null,
    });
  }

  /** Keep the audit log for one year. */
  prune(): number {
    const cutoff = now() - 365 * 86_400_000;
    return this.db.auditLog.removeWhere((e) => e.at < cutoff);
  }
}
