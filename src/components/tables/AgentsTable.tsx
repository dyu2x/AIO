import { ExportDataButton } from '../common/ExportDataButton';
import React, { useMemo, useState } from 'react';
import { Search, RotateCcw, ShieldCheck, ShieldOff } from 'lucide-react';
import { useCRM } from '../../context/CRMContext';
import { Agent } from '../../types/crm';
import { TablePagination } from '../common/TablePagination';

export const AgentsTable: React.FC = () => {
  const { agents, editAgent, roleNames, currentUser } = useCRM();
  const isAdmin = String(currentUser?.role || '').trim().toLowerCase() === 'admin';
  const isManager = String(currentUser?.role || '').trim().toLowerCase() === 'manager';
  const isProtectedRole = (value: string) => ['admin', 'manager'].includes(String(value || '').trim().toLowerCase());
  const visibleAgents = isManager ? agents.filter((agent) => !isProtectedRole(agent.role)) : agents;
  // The API already hides privileged roles from non-admins. Keep this client-side
  // guard as a second layer so only a current Admin sees Admin/Manager choices.
  const availableRoles = Array.from(new Set(roleNames))
    .filter((role) => isAdmin || !isProtectedRole(role))
    .sort((a, b) => a.localeCompare(b));

  const [searchTerm, setSearchTerm] = useState('');
  const [roleFilter, setRoleFilter] = useState('ALL');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const hasActiveFilters = searchTerm !== '' || roleFilter !== 'ALL';
  const clearFilters = () => { setSearchTerm(''); setRoleFilter('ALL'); setCurrentPage(1); };

  const filteredData = useMemo(() => visibleAgents.filter((agent) => {
    const term = searchTerm.toLowerCase();
    const matchesSearch = agent.name.toLowerCase().includes(term)
      || agent.username.toLowerCase().includes(term)
      || String(agent.email || '').toLowerCase().includes(term)
      || String(agent.phone || '').includes(searchTerm);
    return matchesSearch && (roleFilter === 'ALL' || agent.role === roleFilter);
  }), [visibleAgents, searchTerm, roleFilter]);

  const paginatedData = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredData.slice(start, start + pageSize);
  }, [filteredData, currentPage, pageSize]);

  const setAgentRole = (agent: Agent, nextRole: string) => {
    if ((!isAdmin && !isManager) || !availableRoles.includes(nextRole) || nextRole === agent.role) return;
    // Managers may only assign ordinary roles. Admins alone can assign Admin or Manager.
    if (!isAdmin && isProtectedRole(nextRole)) return;
    // Admin accounts remain protected. Managers cannot edit privileged accounts.
    if (agent.role.toLowerCase() === 'admin' || (!isAdmin && isProtectedRole(agent.role))) return;
    editAgent(agent.agent_id, { role: nextRole });
  };

  const toggleAccountStatus = (agent: Agent) => {
    if (!isAdmin || agent.role === 'Admin') return;
    editAgent(agent.agent_id, { status: agent.status === 'Active' ? 'Inactive' : 'Active' });
  };

  return (
    <div className="space-y-4">
      <div className="bg-white p-4 rounded-lg border border-neutral-200 shadow-2xs flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input type="text" placeholder="Search agents (name, username, email)..." value={searchTerm}
            onChange={(e) => { setSearchTerm(e.target.value); setCurrentPage(1); }}
            className="w-full pl-9 pr-3 py-1.5 text-xs border border-neutral-300 rounded focus:outline-none focus:ring-1 focus:ring-black focus:border-black" />
        </div>
        <div className="flex items-center gap-2">
          <select value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); setCurrentPage(1); }}
            className="text-xs border border-neutral-300 rounded px-2.5 py-1.5 bg-white text-neutral-800 focus:outline-none focus:ring-1 focus:ring-black">
            <option value="ALL">All Roles</option>
            {availableRoles.map((role) => <option key={role} value={role}>{role}</option>)}
          </select>
          {hasActiveFilters && <button onClick={clearFilters} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-neutral-600 hover:text-black border border-neutral-300 rounded hover:bg-neutral-50 transition">
            <RotateCcw className="w-3 h-3" /><span>Reset</span>
          </button>}
        </div>
      </div>

      <div className="flex justify-end"><ExportDataButton tableKey="agents" tableLabel="Agents" rows={filteredData as unknown as Record<string, unknown>[]} /></div>

      <div className="bg-white rounded-lg border border-neutral-200 shadow-2xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead><tr className="bg-neutral-50 text-neutral-600 font-semibold border-b border-neutral-200">
              <th className="py-3 px-4">Agent ID</th><th className="py-3 px-4">Name</th><th className="py-3 px-4">Role</th>
              <th className="py-3 px-4">Username</th><th className="py-3 px-4">Phone &amp; Email</th><th className="py-3 px-4">Status</th>
              <th className="py-3 px-4">Date Started</th>{isAdmin && <th className="py-3 px-4 text-right">Account Access</th>}
            </tr></thead>
            <tbody className="divide-y divide-neutral-100 text-neutral-800">
              {paginatedData.map((agent) => <tr key={agent.agent_id} className="hover:bg-neutral-50/70 transition">
                <td className="py-3 px-4 font-mono font-bold text-neutral-900">#{agent.agent_id}</td>
                <td className="py-3 px-4"><div className="font-semibold text-neutral-900">{agent.name}</div><div className="text-[11px] text-neutral-500">{agent.address}</div></td>
                <td className="py-3 px-4">
                  {(isAdmin || isManager) && agent.role.toLowerCase() !== 'admin' && (isAdmin || !isProtectedRole(agent.role)) ? <select aria-label={`Assign role to ${agent.name}`} value={agent.role}
                    onChange={(e) => setAgentRole(agent, e.target.value)} className="max-w-44 rounded border border-neutral-300 bg-white px-2 py-1 text-xs">
                    {availableRoles.map((role) => <option key={role} value={role}>{role}</option>)}
                  </select> : <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${agent.role === 'Admin' ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-700'}`}>{agent.role}</span>}
                </td>
                <td className="py-3 px-4 font-mono font-medium text-neutral-800">{agent.username}</td>
                <td className="py-3 px-4"><div className="font-mono text-neutral-700">{agent.phone || '—'}</div><div className="text-[10px] text-neutral-400">{agent.email || '—'}</div></td>
                <td className="py-3 px-4"><span className={`inline-flex items-center gap-1 text-[11px] font-medium ${agent.status === 'Active' ? 'text-emerald-700' : 'text-amber-700'}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${agent.status === 'Active' ? 'bg-emerald-500' : 'bg-amber-500'}`} /><span>{agent.status}</span>
                </span></td>
                <td className="py-3 px-4 text-neutral-400 text-[11px]">{agent.date_started ? new Date(agent.date_started).toLocaleDateString() : '—'}</td>
                {isAdmin && <td className="py-3 px-4 text-right">
                  {agent.role !== 'Admin' && <button onClick={() => toggleAccountStatus(agent)} className={`inline-flex items-center gap-1 rounded border px-2.5 py-1.5 text-xs font-medium ${agent.status === 'Active' ? 'border-amber-200 text-amber-800 hover:bg-amber-50' : 'border-emerald-200 text-emerald-800 hover:bg-emerald-50'}`}>
                    {agent.status === 'Active' ? <><ShieldOff className="h-3 w-3"/>Deactivate</> : <><ShieldCheck className="h-3 w-3"/>Activate</>}
                  </button>}
                </td>}
              </tr>)}
              {paginatedData.length === 0 && <tr><td colSpan={isAdmin ? 8 : 7} className="py-8 text-center text-neutral-500">No agents found.</td></tr>}
            </tbody>
          </table>
        </div>
        <TablePagination totalItems={filteredData.length} currentPage={currentPage} pageSize={pageSize} onPageChange={setCurrentPage} onPageSizeChange={setPageSize} />
      </div>
    </div>
  );
};
