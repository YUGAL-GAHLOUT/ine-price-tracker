import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import Dashboard from './pages/Dashboard.jsx';
import AddProduct from './pages/AddProduct.jsx';
import ProductDetail from './pages/ProductDetail.jsx';
import Activity from './pages/Activity.jsx';

export default function App() {
  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <div className="brand">INE Price Tracker<span>demo.inelabteamdev.com</span></div>
          <nav className="nav">
            <NavLink to="/" end>Dashboard</NavLink>
            <NavLink to="/add">Add product</NavLink>
            <NavLink to="/activity">Activity</NavLink>
          </nav>
        </div>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/add" element={<AddProduct />} />
          <Route path="/products/:id" element={<ProductDetail />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </>
  );
}
