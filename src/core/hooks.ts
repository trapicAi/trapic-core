/**
 * Optional hooks for audit logging and quota checking.
 * Default: no-op (open source / self-hosted mode).
 * Override for production features (audit logging, monthly limits).
 */

export type AuditFn = (
  userId: string,
  action: string,
  resourceType: string,
  resourceId?: string,
  metadata?: Record<string, unknown>,
) => void;

export type QuotaFn = (userId: string) => Promise<{
  allowed: boolean;
  used: number;
  limit: number;
}>;

/** Default: no audit logging */
export const noopAudit: AuditFn = () => {};

/** Default: no quota limit */
export const noopQuota: QuotaFn = async () => ({
  allowed: true,
  used: 0,
  limit: Infinity,
});

/**
 * Hooks container — override these for production features (audit logging, quotas).
 * Default: no-op (open source mode — no audit, no quota).
 */
export const hooks = {
  audit: noopAudit as AuditFn,
  quota: noopQuota as QuotaFn,
};

/** Call at startup to warn if hooks are not wired */
export function warnIfNoopHooks(): void {
  if (hooks.audit === noopAudit) {
    console.warn("[trapic] Audit logging disabled (no-op). Wire hooks.audit for production.");
  }
  if (hooks.quota === noopQuota) {
    console.warn("[trapic] Quota enforcement disabled (no-op). Wire hooks.quota for production.");
  }
}
