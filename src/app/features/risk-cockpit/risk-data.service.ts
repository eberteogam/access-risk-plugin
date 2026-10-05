import { inject, Injectable } from '@angular/core';
import { SailpointPluginService } from '@core';
import { ApiError } from '@sailpoint/ui-plugin-sdk';
import { isPrivileged, type SourceAccount, type SourceEntitlement } from './risk-engine';

export interface SourceOption {
  id: string;
  name: string;
  connectorName?: string;
}

const PAGE = 250;

/** Loads one source's accounts and entitlements through the plugin's scoped token. */
@Injectable({ providedIn: 'root' })
export class RiskDataService {
  private readonly plugin = inject(SailpointPluginService);

  async listSources(): Promise<SourceOption[]> {
    const rows = await this.getFirst<any[]>([`/sources/v1?limit=${PAGE}`, `/v3/sources?limit=${PAGE}`]);
    return (rows ?? [])
      .map((s) => ({ id: s.id, name: s.name, connectorName: s.connectorName }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async loadAccounts(sourceId: string): Promise<SourceAccount[]> {
    const filter = encodeURIComponent(`sourceId eq "${sourceId}"`);
    const rows = await this.pageAll((offset) => [
      `/accounts/v1?filters=${filter}&limit=${PAGE}&offset=${offset}`,
      `/v3/accounts?filters=${filter}&limit=${PAGE}&offset=${offset}`,
    ]);
    return rows.map((a) => ({
      id: a.id,
      nativeIdentity: a.nativeIdentity,
      name: a.name ?? a.nativeIdentity,
      disabled: !!a.disabled,
      locked: !!a.locked,
      uncorrelated: !!a.uncorrelated,
      identityId: a.identityId,
      attributes: a.attributes ?? {},
    }));
  }

  async loadEntitlements(sourceId: string): Promise<SourceEntitlement[]> {
    const filter = encodeURIComponent(`source.id eq "${sourceId}"`);
    const rows = await this.pageAll((offset) => [
      `/entitlements/v1?filters=${filter}&limit=${PAGE}&offset=${offset}`,
      `/beta/entitlements?filters=${filter}&limit=${PAGE}&offset=${offset}`,
    ]);
    return rows.map((e) => {
      const mapped: SourceEntitlement = {
        id: e.id,
        value: e.value ?? e.name,
        name: e.name ?? e.value,
        displayName: e.attributes?.displayName ?? e.name ?? e.value,
        status: e.attributes?.status,
        privileged: !!e.privileged,
        permissions: e.directPermissions ?? e.permissions ?? [],
      };
      return { ...mapped, privileged: isPrivileged(mapped) };
    });
  }

  /** Runs a disabled workflow once with this input (the workflow test-run endpoint). */
  async runWorkflow(workflowId: string, input: object): Promise<string | undefined> {
    const id = encodeURIComponent(workflowId);
    let lastError: unknown;
    for (const path of [`/workflows/v1/${id}/test`, `/v3/workflows/${id}/test`]) {
      try {
        const res = await this.plugin.post<{ workflowExecutionId?: string }>(path, { input });
        return res?.workflowExecutionId;
      } catch (err) {
        lastError = err;
        if (!(err instanceof ApiError) || err.status !== 404) throw err;
      }
    }
    throw lastError;
  }

  /** Follows offset paging until a short page comes back. */
  private async pageAll(pathsFor: (offset: number) => string[]): Promise<any[]> {
    const all: any[] = [];
    for (let offset = 0; offset < 10_000; offset += PAGE) {
      const page = (await this.getFirst<any[]>(pathsFor(offset))) ?? [];
      const items = Array.isArray(page) ? page : ((page as any).items ?? []);
      all.push(...items);
      if (items.length < PAGE) break;
    }
    return all;
  }

  /** Tries the current API path first and falls back to the legacy one on 404. */
  private async getFirst<T>(paths: string[]): Promise<T> {
    let lastError: unknown;
    for (const path of paths) {
      try {
        return await this.plugin.get<T>(path);
      } catch (err) {
        lastError = err;
        if (!(err instanceof ApiError) || err.status !== 404) throw err;
      }
    }
    throw lastError;
  }
}
