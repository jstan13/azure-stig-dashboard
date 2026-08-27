import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthenticatedTemplate, UnauthenticatedTemplate } from '@azure/msal-react';
import { initializeIcons } from '@fluentui/react';
import { AuthzProvider } from './auth/AuthzProvider';
import { RUNTIME_CONFIG } from './runtime-config';
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
import UpdatesPage from './pages/UpdatesPage';
import ScanSchedulePage from './pages/ScanSchedulePage';

// Initialize Fluent UI icons
initializeIcons();

function SignedInApp() {
  return (
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
          <Route path="/updates" element={<UpdatesPage />} />
          <Route path="/scan-schedule" element={<ScanSchedulePage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </AppShell>
    </AuthzProvider>
  );
}

export default function App() {
  // MOCK_MODE is the demo build. The backend it talks to also runs with
  // MOCK_MODE and injects a synthetic principal instead of validating tokens,
  // so there is no sign-in that could succeed — gating the UI on one would
  // leave the demo stuck on a login page forever. Both flags come from the
  // single `mockMode` deployment parameter, which defaults to false.
  if (RUNTIME_CONFIG.MOCK_MODE) {
    return (
      <BrowserRouter>
        <SignedInApp />
      </BrowserRouter>
    );
  }

  return (
    <BrowserRouter>
      <UnauthenticatedTemplate>
        <Routes>
          <Route path="*" element={<LoginPage />} />
        </Routes>
      </UnauthenticatedTemplate>

      <AuthenticatedTemplate>
        <SignedInApp />
      </AuthenticatedTemplate>
    </BrowserRouter>
  );
}
