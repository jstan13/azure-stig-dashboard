import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthenticatedTemplate, UnauthenticatedTemplate } from '@azure/msal-react';
import { initializeIcons } from '@fluentui/react';
import { AuthzProvider } from './auth/AuthzProvider';
import AppShell from './components/AppShell';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import CloudExplorerPage from './pages/CloudExplorerPage';
import InventoryPage from './pages/InventoryPage';
import MachinePage from './pages/MachinePage';
import PoolsPage from './pages/PoolsPage';
import GroupPage from './pages/GroupPage';
import AuditPage from './pages/AuditPage';
import StigLibraryPage from './pages/StigLibraryPage';
import StigDetailPage from './pages/StigDetailPage';
import PoamPage from './pages/PoamPage';
import ComplianceTrendPage from './pages/ComplianceTrendPage';
import UserManagementPage from './pages/UserManagementPage';
import RmfPage from './pages/RmfPage';
import VulnerabilitiesPage from './pages/VulnerabilitiesPage';
import BulkRemediationPage from './pages/BulkRemediationPage';
import EmassPage from './pages/EmassPage';
import AdminPage from './pages/AdminPage';

// Initialize Fluent UI icons
initializeIcons();

export default function App() {
  return (
    <BrowserRouter>
      <UnauthenticatedTemplate>
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
      </UnauthenticatedTemplate>

      <AuthenticatedTemplate>
        <AuthzProvider>
          <AppShell>
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/explorer" element={<CloudExplorerPage />} />
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/machines/:id" element={<MachinePage />} />
              <Route path="/pools" element={<PoolsPage />} />
              <Route path="/groups/:id" element={<GroupPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/stigs" element={<StigLibraryPage />} />
              <Route path="/stigs/:benchmarkId" element={<StigDetailPage />} />
              <Route path="/poams" element={<PoamPage />} />
              <Route path="/trends" element={<ComplianceTrendPage />} />
              <Route path="/users" element={<UserManagementPage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route path="/rmf" element={<RmfPage />} />
              <Route path="/vulnerabilities" element={<VulnerabilitiesPage />} />
              <Route path="/remediation" element={<BulkRemediationPage />} />
              <Route path="/emass" element={<EmassPage />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </AppShell>
        </AuthzProvider>
      </AuthenticatedTemplate>
    </BrowserRouter>
  );
}
