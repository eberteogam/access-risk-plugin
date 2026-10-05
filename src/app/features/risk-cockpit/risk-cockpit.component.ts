import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SailpointPluginService } from '@core';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { SERVICENOW_WORKFLOW_ID } from './handoff.config';
import { MOCK_ACCOUNTS, MOCK_ENTITLEMENTS, MOCK_SOURCE } from './mock-data';
import { RiskDataService, type SourceOption } from './risk-data.service';
import {
  analyzeSource,
  applyRevocations,
  FACTOR_META,
  type FactorKey,
  isPrivileged,
  LocalNarrativeProvider,
  type NarrativeProvider,
  recommendedRevocations,
  revocationKey,
  type RiskBand,
  type RiskFactor,
  riskPoints,
  type ScoredAccount,
  type SourceAccount,
  type SourceEntitlement,
} from './risk-engine';

type BandFilter = 'all' | 'critical' | 'high' | 'medium';

@Component({
  selector: 'app-risk-cockpit',
  standalone: true,
  imports: [FormsModule, ButtonModule, SelectModule, TableModule, TagModule],
  templateUrl: './risk-cockpit.component.html',
  styleUrl: './risk-cockpit.component.scss',
})
export class RiskCockpitComponent implements OnInit {
  private readonly plugin = inject(SailpointPluginService);
  private readonly data = inject(RiskDataService);
  private readonly narrator: NarrativeProvider = new LocalNarrativeProvider();

  protected readonly mode = signal<'live' | 'sample'>('live');
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly sources = signal<SourceOption[]>([]);
  protected readonly sourceId = signal<string | null>(null);
  protected readonly summary = signal('');
  protected readonly selectedId = signal<string | null>(null);
  protected readonly bandFilter = signal<BandFilter>('all');

  /** Raw source data and the set of grants revoked in the preview. */
  private readonly raw = signal<{ accounts: SourceAccount[]; entitlements: SourceEntitlement[] } | null>(null);
  protected readonly revoked = signal<ReadonlySet<string>>(new Set());

  /** Scores as the source is today. */
  protected readonly baseline = computed(() => {
    const r = this.raw();
    return r ? analyzeSource(r.accounts, r.entitlements) : null;
  });

  /** Scores with the previewed revocations applied. Identical to baseline when nothing is previewed. */
  protected readonly insights = computed(() => {
    const r = this.raw();
    if (!r) return null;
    const revoked = this.revoked();
    return revoked.size === 0 ? this.baseline() : analyzeSource(applyRevocations(r.accounts, revoked), r.entitlements);
  });

  protected readonly impact = computed(() => {
    const before = this.baseline();
    const after = this.insights();
    if (!before || !after || this.revoked().size === 0) return null;
    const pointsBefore = riskPoints(before);
    const pointsAfter = riskPoints(after);
    return {
      revocations: this.revoked().size,
      pointsBefore,
      pointsAfter,
      percent: pointsBefore === 0 ? 0 : Math.round(((pointsBefore - pointsAfter) / pointsBefore) * 100),
      reviewBefore: before.totals.atRisk,
      reviewAfter: after.totals.atRisk,
    };
  });

  private readonly baselineScores = computed(
    () => new Map((this.baseline()?.scored ?? []).map((s) => [s.account.id, s.score]))
  );

  protected readonly selected = computed(
    () => this.insights()?.scored.find((s) => s.account.id === this.selectedId()) ?? null
  );
  protected readonly selectedBaseline = computed(
    () => this.baseline()?.scored.find((s) => s.account.id === this.selectedId()) ?? null
  );

  protected readonly narratorLabel = this.narrator.label;
  protected readonly factorKeys = Object.keys(FACTOR_META) as FactorKey[];
  protected readonly factorMeta = FACTOR_META;
  protected readonly bandFilters: { value: BandFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'critical', label: 'Critical' },
    { value: 'high', label: 'High' },
    { value: 'medium', label: 'Medium' },
  ];

  protected readonly handoffEnabled = SERVICENOW_WORKFLOW_ID.trim().length > 0;
  protected readonly handoffState = signal<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  protected readonly handoffMessage = signal('');

  protected readonly sourceName = computed(
    () => this.sources().find((s) => s.id === this.sourceId())?.name ?? 'this source'
  );

  protected readonly visible = computed(() => {
    const rows = this.insights()?.scored ?? [];
    const band = this.bandFilter();
    return band === 'all' ? rows : rows.filter((r) => r.band === band);
  });

  async ngOnInit(): Promise<void> {
    if (this.plugin.status() !== 'ready') {
      this.useSampleData();
      return;
    }
    this.loading.set(true);
    try {
      const sources = await this.data.listSources();
      this.sources.set(sources);
      const preferred =
        sources.find((s) => /saas connectivity demo/i.test(`${s.name} ${s.connectorName ?? ''}`)) ?? sources[0];
      if (preferred) {
        await this.selectSource(preferred.id);
      } else {
        this.error.set('No sources found in this tenant. Create the SaaS Connectivity Demo source and aggregate it first.');
      }
    } catch (err) {
      this.error.set(this.describe(err));
    } finally {
      this.loading.set(false);
    }
  }

  async selectSource(id: string): Promise<void> {
    this.sourceId.set(id);
    this.selectedId.set(null);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const id = this.sourceId();
    if (this.mode() === 'sample' || !id) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const [accounts, entitlements] = await Promise.all([
        this.data.loadAccounts(id),
        this.data.loadEntitlements(id),
      ]);
      await this.publish(accounts, entitlements);
    } catch (err) {
      this.error.set(this.describe(err));
    } finally {
      this.loading.set(false);
    }
  }

  // ─── Preview ────────────────────────────────────────────────────────────────

  protected isRevoked(accountId: string, value: string): boolean {
    return this.revoked().has(revocationKey(accountId, value));
  }

  protected toggleRevoke(accountId: string, value: string): void {
    const next = new Set(this.revoked());
    const key = revocationKey(accountId, value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.revoked.set(next);
  }

  /** Previews the recommended fix for one factor, or undoes it if it is already previewed. */
  protected previewFix(accountId: string, factor: RiskFactor): void {
    const keys = (factor.fixes ?? []).map((v) => revocationKey(accountId, v));
    const next = new Set(this.revoked());
    const allOn = keys.length > 0 && keys.every((k) => next.has(k));
    for (const k of keys) {
      if (allOn) next.delete(k);
      else next.add(k);
    }
    this.revoked.set(next);
  }

  protected fixPreviewed(accountId: string, factor: RiskFactor): boolean {
    const keys = factor.fixes ?? [];
    return keys.length > 0 && keys.every((v) => this.revoked().has(revocationKey(accountId, v)));
  }

  protected previewAllFixes(): void {
    const base = this.baseline();
    if (base) this.revoked.set(recommendedRevocations(base));
  }

  protected resetPreview(): void {
    this.revoked.set(new Set());
    this.handoffState.set('idle');
    this.handoffMessage.set('');
  }

  protected previousScore(row: ScoredAccount): number | null {
    const before = this.baselineScores().get(row.account.id);
    return before !== undefined && before !== row.score ? before : null;
  }

  /** Sends the previewed plan to ServiceNow through the configured ISC workflow. */
  protected async sendPlan(): Promise<void> {
    const impact = this.impact();
    const base = this.baseline();
    if (!impact || !base || !this.handoffEnabled) return;
    const names = new Map(base.scored.map((s) => [s.account.id, s.displayName]));
    const entNames = new Map(base.scored.flatMap((s) => s.entitlements.map((e) => [e.value, e.displayName] as const)));
    const lines = [...this.revoked()].map((key) => {
      const [accountId, value] = key.split('::');
      return `Revoke ${entNames.get(value) ?? value} from ${names.get(accountId) ?? accountId}`;
    });
    this.handoffState.set('sending');
    try {
      const executionId = await this.data.runWorkflow(SERVICENOW_WORKFLOW_ID, {
        title: `Access cleanup for ${this.sourceName()}: ${impact.revocations} revocations, risk ${impact.pointsBefore} to ${impact.pointsAfter}`,
        source: this.sourceName(),
        revocations: impact.revocations,
        riskBefore: impact.pointsBefore,
        riskAfter: impact.pointsAfter,
        plan: lines.join(' | '),
      });
      this.handoffState.set('sent');
      this.handoffMessage.set(`Sent to ServiceNow through the workflow${executionId ? ` (execution ${executionId})` : ''}.`);
    } catch (err) {
      this.handoffState.set('failed');
      this.handoffMessage.set(`Couldn't run the workflow: ${this.describe(err)}`);
    }
  }

  // ─── View helpers ───────────────────────────────────────────────────────────

  protected select(row: ScoredAccount): void {
    this.selectedId.set(this.selectedId() === row.account.id ? null : row.account.id);
  }

  protected setBand(band: BandFilter): void {
    this.bandFilter.set(band);
  }

  protected severity(band: RiskBand): 'danger' | 'warn' | 'info' | 'secondary' {
    return band === 'critical' ? 'danger' : band === 'high' ? 'warn' : band === 'medium' ? 'info' : 'secondary';
  }

  protected bandLabel(band: RiskBand, score: number): string {
    return band === 'none' ? 'No findings' : `${band.charAt(0).toUpperCase()}${band.slice(1)} ${score}`;
  }

  protected colorOf(key: string): string {
    return FACTOR_META[key as FactorKey]?.color ?? 'var(--spds-zinc-400)';
  }

  protected isPrivileged = isPrivileged;

  private useSampleData(): void {
    this.mode.set('sample');
    this.sources.set([MOCK_SOURCE]);
    this.sourceId.set(MOCK_SOURCE.id);
    void this.publish(MOCK_ACCOUNTS, MOCK_ENTITLEMENTS);
  }

  private async publish(accounts: SourceAccount[], entitlements: SourceEntitlement[]): Promise<void> {
    this.revoked.set(new Set());
    this.raw.set({ accounts, entitlements });
    const base = this.baseline();
    if (!base) return;
    this.summary.set(await this.narrator.summarize(base, this.sourceName()));
    if (!this.selectedId()) this.selectedId.set(base.scored.find((s) => s.score > 0)?.account.id ?? null);
  }

  private describe(err: unknown): string {
    const status = (err as { status?: number })?.status;
    if (status === 403) return 'The plugin token cannot reach this API. Keep "sp:scopes:all" in apiScopes, then run sail ui-plugins push-manifest.';
    return err instanceof Error ? err.message : String(err);
  }
}
