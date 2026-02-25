import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthenticatedTemplate, UnauthenticatedTemplate } from '@azure/msal-react';
import { initializeIcons } from '@fluentui/react';
import NavBar from './components/NavBar';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import InventoryPage from './pages/InventoryPage';
import MachinePage from './pages/MachinePage';
import GroupPage from './pages/GroupPage';
import AuditPage from './pages/AuditPage';
import StigLibraryPage from './pages/StigLibraryPage';
import StigDetailPage from './pages/StigDetailPage';
import PoamPage from './pages/PoamPage';
import ComplianceTrendPage from './pages/ComplianceTrendPage';
import UserManagementPage from './pages/UserManagementPage';
import RmfPage from './pages/RmfPage';

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
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
          <NavBar />
          <main style={{ flex: 1, padding: '24px', maxWidth: '1400px', margin: '0 auto', width: '100%' }}>
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/inventory" element={<InventoryPage />} />
              <Route path="/machines/:id" element={<MachinePage />} />
              <Route path="/groups/:id" element={<GroupPage />} />
              <Route path="/audit" element={<AuditPage />} />
              <Route path="/stigs" element={<StigLibraryPage />} />
              <Route path="/stigs/:benchmarkId" element={<StigDetailPage />} />
              <Route path="/poams" element={<PoamPage />} />
              <Route path="/trends" element={<ComplianceTrendPage />} />
              <Route path="/users" element={<UserManagementPage />} />
              <Route path="/rmf" element={<RmfPage />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </main>
        </div>
      </AuthenticatedTemplate>
    </BrowserRouter>
  );
}
