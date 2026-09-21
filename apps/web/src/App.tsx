import { Route, Routes } from 'react-router';
import { AdminPage } from './pages/AdminPage';
import { DemoPage } from './pages/DemoPage';
import { NotFoundPage } from './pages/NotFoundPage';
import * as _ from './app.css'


export function App() {
  return (
    <Routes>
      <Route path="/" element={<DemoPage />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}