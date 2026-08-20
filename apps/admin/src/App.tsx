import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminLayout } from '@/layouts/AdminLayout';
import { Login } from '@/pages/Login';
import { Dashboard } from '@/pages/Dashboard';

/**
 * P0 routing structure. Real admin auth/permissions are NOT implemented yet —
 * routes are open placeholders. Guards will be added in a later phase.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<AdminLayout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
