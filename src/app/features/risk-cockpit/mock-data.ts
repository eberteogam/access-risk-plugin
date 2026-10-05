import type { SourceAccount, SourceEntitlement } from './risk-engine';

/**
 * Synthetic data shaped like the SaaS Connectivity Demo source. Used only when
 * the plugin runs outside ISC (no App Shell handshake), so the UI always renders.
 */
export const MOCK_SOURCE = { id: 'demo-source', name: 'SaaS Connectivity Demo (sample data)' };

const ent = (value: string, name: string, displayName: string, extra: Partial<SourceEntitlement> = {}): SourceEntitlement => ({
  id: `ent-${value}`,
  value,
  name,
  displayName,
  status: 'active',
  privileged: false,
  permissions: [],
  ...extra,
});

export const MOCK_ENTITLEMENTS: SourceEntitlement[] = [
  ent('grp_all', 'all-staff', 'All staff'),
  ent('grp_eng', 'engineering', 'Engineering'),
  ent('grp_sales', 'sales-crm', 'Sales CRM'),
  ent('grp_hr', 'hr-records', 'HR records', { permissions: [{ target: 'hr', rights: ['read'] }] }),
  ent('grp_fin', 'finance-admin', 'Finance admin', { permissions: [{ target: 'ledger', rights: ['admin'] }] }),
  ent('grp_it', 'it-admin', 'IT admin', { permissions: [{ target: 'servers', rights: ['admin', 'write'] }] }),
  ent('grp_pay', 'payroll-write', 'Payroll write', { permissions: [{ target: 'payroll', rights: ['write'] }] }),
  ent('grp_vpn', 'legacy-vpn', 'Legacy VPN', { status: 'deprecated' }),
];

const FIRST = ['Ana', 'Ben', 'Carla', 'Dev', 'Elena', 'Femi', 'Gus', 'Hana', 'Ivan', 'Jade', 'Kai', 'Lena', 'Marco', 'Nia', 'Omar', 'Priya', 'Quinn'];
const LAST = ['Rivera', 'Okafor', 'Chen', 'Patel', 'Novak', 'Silva', 'Kim', 'Haddad', 'Moreau', 'Ito'];
const DEPTS: { name: string; size: number; groups: string[]; title: string }[] = [
  { name: 'Engineering', size: 12, groups: ['grp_all', 'grp_eng'], title: 'Software engineer' },
  { name: 'Sales', size: 10, groups: ['grp_all', 'grp_sales'], title: 'Account executive' },
  { name: 'Finance', size: 8, groups: ['grp_all', 'grp_fin'], title: 'Financial analyst' },
  { name: 'Human Resources', size: 6, groups: ['grp_all', 'grp_hr', 'grp_pay'], title: 'HR partner' },
  { name: 'IT', size: 6, groups: ['grp_all', 'grp_it'], title: 'Systems administrator' },
  { name: 'Marketing', size: 8, groups: ['grp_all'], title: 'Marketing manager' },
];

function build(): SourceAccount[] {
  const accounts: SourceAccount[] = [];
  let n = 0;
  for (const dept of DEPTS) {
    for (let i = 0; i < dept.size; i++, n++) {
      const first = FIRST[n % FIRST.length];
      const last = LAST[(n * 7) % LAST.length];
      const id = `usr_${String(n).padStart(3, '0')}`;
      accounts.push({
        id: `acct-${id}`,
        nativeIdentity: id,
        name: `${first.toLowerCase()}.${last.toLowerCase()}`,
        disabled: false,
        locked: false,
        uncorrelated: false,
        attributes: {
          id,
          displayName: `${first} ${last}`,
          department: dept.name,
          title: dept.title,
          manager: i === 0 ? null : 'usr_000',
          active: true,
          locked: false,
          groups: [...dept.groups],
        },
      });
    }
  }
  const set = (i: number, patch: (a: SourceAccount) => void) => patch(accounts[i]);
  // Disabled but still entitled, one of them with IT admin.
  set(3, (a) => { a.disabled = true; a.attributes['active'] = false; });
  set(15, (a) => { a.disabled = true; a.attributes['active'] = false; });
  set(45, (a) => { a.disabled = true; a.attributes['active'] = false; a.attributes['groups'].push('grp_it'); });
  // Deprecated access lingering.
  for (const i of [1, 7, 12, 26, 33]) set(i, (a) => a.attributes['groups'].push('grp_vpn'));
  // Unusual for peers.
  set(5, (a) => a.attributes['groups'].push('grp_fin'));
  set(18, (a) => a.attributes['groups'].push('grp_pay'));
  // Locked with privilege, and an orphan account.
  set(37, (a) => { a.locked = true; a.attributes['locked'] = true; });
  set(44, (a) => { a.uncorrelated = true; a.attributes['groups'].push('grp_it'); });
  return accounts;
}

export const MOCK_ACCOUNTS: SourceAccount[] = build();
