/**
 * Explainable risk scoring for the accounts on one source.
 * Pure functions only: no Angular, no network. Every point a score gets
 * comes from a named factor with a plain-language reason and a next step.
 */

export interface SourceAccount {
  id: string;
  nativeIdentity: string;
  name: string;
  disabled: boolean;
  locked: boolean;
  uncorrelated: boolean;
  identityId?: string;
  attributes: Record<string, any>;
}

export interface SourceEntitlement {
  id: string;
  value: string;
  name: string;
  displayName: string;
  status?: string;
  privileged: boolean;
  permissions: { target?: string; rights?: string[] }[];
}

export type FactorKey =
  | 'dormant'
  | 'orphan'
  | 'deprecated'
  | 'privileged'
  | 'peerOutlier'
  | 'lockedPrivileged'
  | 'noManager';

export interface RiskFactor {
  key: FactorKey;
  points: number;
  title: string;
  detail: string;
  action: string;
  /** Entitlement values the recommended fix would revoke (empty when the fix needs a human decision). */
  fixes?: string[];
}

export type RiskBand = 'critical' | 'high' | 'medium' | 'low' | 'none';

export interface ScoredAccount {
  account: SourceAccount;
  displayName: string;
  department: string;
  jobTitle: string;
  entitlements: SourceEntitlement[];
  factors: RiskFactor[];
  score: number;
  band: RiskBand;
}

export interface SourceInsights {
  scored: ScoredAccount[];
  correlationGap: boolean;
  totals: {
    accounts: number;
    atRisk: number;
    dormant: number;
    deprecatedGrants: number;
    privilegedHolders: number;
    outliers: number;
    uncorrelated: number;
  };
}

/** Display order, labels and colors for the reason bar legend. */
export const FACTOR_META: Record<FactorKey, { label: string; color: string }> = {
  dormant: { label: 'Disabled but entitled', color: 'var(--spds-red-500, #dc2626)' },
  orphan: { label: 'No owner', color: 'var(--spds-amber-500, #f59e0b)' },
  deprecated: { label: 'Deprecated access', color: 'var(--spds-amber-700, #b45309)' },
  privileged: { label: 'Privileged access', color: 'var(--spds-purple-500, #8b5cf6)' },
  peerOutlier: { label: 'Unusual for peers', color: 'var(--spds-sky-500, #0ea5e9)' },
  lockedPrivileged: { label: 'Locked with privilege', color: 'var(--spds-teal-600, #0d9488)' },
  noManager: { label: 'No manager', color: 'var(--spds-zinc-400, #a1a1aa)' },
};

const PRIVILEGED_RIGHTS = /admin|write|delete|full|owner|\*/i;
const PEER_MIN_GROUP = 3;
const PEER_RARE_RATIO = 0.2;

export function isPrivileged(e: SourceEntitlement): boolean {
  return e.privileged || e.permissions.some((p) => (p.rights ?? []).some((r) => PRIVILEGED_RIGHTS.test(r)));
}

export function bandFor(score: number): RiskBand {
  if (score >= 60) return 'critical';
  if (score >= 35) return 'high';
  if (score >= 15) return 'medium';
  if (score > 0) return 'low';
  return 'none';
}

function groupValues(account: SourceAccount): string[] {
  const raw = account.attributes?.['groups'];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.length > 0) return [raw];
  return [];
}

function listNames(items: SourceEntitlement[], max = 3): string {
  const names = items.map((e) => e.displayName);
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

export function analyzeSource(accounts: SourceAccount[], entitlements: SourceEntitlement[]): SourceInsights {
  const byValue = new Map<string, SourceEntitlement>();
  for (const e of entitlements) byValue.set(e.value, e);

  const resolve = (value: string): SourceEntitlement =>
    byValue.get(value) ?? { id: value, value, name: value, displayName: value, privileged: false, permissions: [] };

  const held = new Map<string, SourceEntitlement[]>();
  for (const a of accounts) held.set(a.id, [...new Set(groupValues(a))].map(resolve));

  const uncorrelated = accounts.filter((a) => a.uncorrelated).length;
  // If almost nothing is correlated, "no owner" is a source setup issue, not per-account risk.
  const correlationGap = accounts.length > 0 && uncorrelated / accounts.length > 0.8;

  const deptOf = (a: SourceAccount): string =>
    String(a.attributes?.['department'] ?? a.attributes?.['title'] ?? 'Unassigned');
  const peers = new Map<string, SourceAccount[]>();
  for (const a of accounts) {
    const d = deptOf(a);
    peers.set(d, [...(peers.get(d) ?? []), a]);
  }

  const scored: ScoredAccount[] = accounts.map((account) => {
    const ents = held.get(account.id) ?? [];
    const department = deptOf(account);
    const factors: RiskFactor[] = [];
    const inactive = account.disabled || account.attributes?.['active'] === false;
    const privileged = ents.filter(isPrivileged);
    const deprecated = ents.filter((e) => (e.status ?? '').toLowerCase() === 'deprecated');

    if (inactive && ents.length > 0) {
      factors.push({
        key: 'dormant',
        points: 40,
        title: 'Disabled account still holds access',
        detail: `The account is disabled in the source but keeps ${ents.length} entitlement${ents.length === 1 ? '' : 's'}: ${listNames(ents)}.`,
        action: 'Remove the entitlements, or confirm the account should stay disabled with access.',
        fixes: ents.map((e) => e.value),
      });
    }

    if (!correlationGap && account.uncorrelated && ents.length > 0) {
      factors.push({
        key: 'orphan',
        points: 15,
        title: 'No identity owns this account',
        detail: 'The account is not correlated to any identity, so nobody is accountable for its access.',
        action: 'Correlate the account to its owner, or remove it if nobody claims it.',
      });
    }

    if (deprecated.length > 0) {
      factors.push({
        key: 'deprecated',
        points: Math.min(30, deprecated.length * 15),
        title: 'Holds deprecated access',
        detail: `${listNames(deprecated)} ${deprecated.length === 1 ? 'is' : 'are'} marked deprecated in the source.`,
        action: `Revoke ${listNames(deprecated)}.`,
        fixes: deprecated.map((e) => e.value),
      });
    }

    if (privileged.length > 0) {
      factors.push({
        key: 'privileged',
        points: Math.min(24, privileged.length * 12),
        title: 'Holds privileged access',
        detail: `${listNames(privileged)} grant${privileged.length === 1 ? 's' : ''} elevated rights.`,
        action: 'Confirm there is a current business need for this access.',
      });
    }

    const deptPeers = (peers.get(department) ?? []).filter((p) => p.id !== account.id);
    if (deptPeers.length >= PEER_MIN_GROUP) {
      const rare = ents.filter((e) => {
        if ((e.status ?? '').toLowerCase() === 'deprecated') return false; // already its own factor
        const holders = deptPeers.filter((p) => (held.get(p.id) ?? []).some((x) => x.value === e.value)).length;
        return holders / deptPeers.length < PEER_RARE_RATIO;
      });
      if (rare.length > 0) {
        const first = rare[0];
        const holders = deptPeers.filter((p) => (held.get(p.id) ?? []).some((x) => x.value === first.value)).length;
        factors.push({
          key: 'peerOutlier',
          points: Math.min(20, rare.length * 10),
          title: 'Access is unusual for peers',
          detail: `${listNames(rare)} ${rare.length === 1 ? 'is' : 'are'} rare in ${department}: only ${holders} of ${deptPeers.length} peers hold ${first.displayName}.`,
          action: `Review whether ${department} needs ${listNames(rare)}.`,
          fixes: rare.map((e) => e.value),
        });
      }
    }

    if (account.locked && privileged.length > 0) {
      factors.push({
        key: 'lockedPrivileged',
        points: 10,
        title: 'Locked account with privileged access',
        detail: 'Lockouts on privileged accounts can signal password attacks.',
        action: 'Check recent sign-in failures before unlocking.',
      });
    }

    if (privileged.length > 0 && !account.attributes?.['manager']) {
      factors.push({
        key: 'noManager',
        points: 6,
        title: 'No manager on record',
        detail: 'Privileged access with no manager means reviews have nowhere to go.',
        action: 'Add a manager in the source so access reviews reach someone.',
      });
    }

    const score = Math.min(100, factors.reduce((sum, f) => sum + f.points, 0));
    return {
      account,
      displayName: String(account.attributes?.['displayName'] ?? account.name ?? account.nativeIdentity),
      department,
      jobTitle: String(account.attributes?.['title'] ?? ''),
      entitlements: ents,
      factors,
      score,
      band: bandFor(score),
    };
  });

  scored.sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));

  return {
    scored,
    correlationGap,
    totals: {
      accounts: accounts.length,
      atRisk: scored.filter((s) => s.score >= 15).length,
      dormant: scored.filter((s) => s.factors.some((f) => f.key === 'dormant')).length,
      deprecatedGrants: scored.reduce(
        (n, s) => n + s.entitlements.filter((e) => (e.status ?? '').toLowerCase() === 'deprecated').length,
        0
      ),
      privilegedHolders: scored.filter((s) => s.factors.some((f) => f.key === 'privileged')).length,
      outliers: scored.filter((s) => s.factors.some((f) => f.key === 'peerOutlier')).length,
      uncorrelated,
    },
  };
}

// ─── What-if preview ────────────────────────────────────────────────────────
// Revocations are previewed by re-running the same scoring on a copy of the
// data with the chosen grants removed. Nothing is written to the tenant.

export const revocationKey = (accountId: string, value: string): string => `${accountId}::${value}`;

export function applyRevocations(accounts: SourceAccount[], revoked: ReadonlySet<string>): SourceAccount[] {
  if (revoked.size === 0) return accounts;
  return accounts.map((a) => {
    const groups = groupValues(a);
    const kept = groups.filter((v) => !revoked.has(revocationKey(a.id, v)));
    return kept.length === groups.length ? a : { ...a, attributes: { ...a.attributes, groups: kept } };
  });
}

/** Every grant the recommended fixes would revoke across the whole source. */
export function recommendedRevocations(insights: SourceInsights): Set<string> {
  const keys = new Set<string>();
  for (const s of insights.scored) {
    for (const f of s.factors) for (const v of f.fixes ?? []) keys.add(revocationKey(s.account.id, v));
  }
  return keys;
}

export function riskPoints(insights: SourceInsights): number {
  return insights.scored.reduce((sum, s) => sum + s.score, 0);
}

/**
 * Narrative layer. Plugins can't reach outside AI services today, so the
 * summary is written here from the computed facts. Swap in an LLM-backed
 * provider when plugin network access allows it; the component only sees
 * this interface.
 */
export interface NarrativeProvider {
  readonly label: string;
  summarize(insights: SourceInsights, sourceName: string): Promise<string>;
}

export class LocalNarrativeProvider implements NarrativeProvider {
  readonly label = 'Written in the plugin from the scored accounts';

  async summarize(insights: SourceInsights, sourceName: string): Promise<string> {
    const t = insights.totals;
    if (t.accounts === 0) {
      return `${sourceName} has no aggregated accounts yet. Run entitlement aggregation, then account aggregation, and refresh.`;
    }
    const parts: string[] = [`${t.atRisk} of ${t.accounts} accounts on ${sourceName} need review.`];
    if (t.dormant > 0) parts.push(`${t.dormant} disabled account${t.dormant === 1 ? '' : 's'} still hold access.`);
    if (t.deprecatedGrants > 0)
      parts.push(`${t.deprecatedGrants} grant${t.deprecatedGrants === 1 ? ' points' : 's point'} to deprecated entitlements.`);
    if (t.outliers > 0)
      parts.push(`${t.outliers} account${t.outliers === 1 ? ' holds' : 's hold'} access that is unusual for their department.`);
    if (insights.correlationGap)
      parts.push('Owner checks are off because the source is not correlated to identities yet.');
    const top = insights.scored.find((s) => s.score > 0);
    if (top) parts.push(`Start with ${top.displayName} (score ${top.score}): ${top.factors[0].title.toLowerCase()}.`);
    return parts.join(' ');
  }
}
