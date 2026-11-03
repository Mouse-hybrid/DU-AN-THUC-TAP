import { Navigate, Route, Routes } from "react-router-dom";
import { getAuth, getHomePath } from "./auth/storage";
import { OfflineBanner } from "./components/OfflineBanner";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { AdminMenuItemPage } from "./pages/AdminMenuItemPage";
import { AdminMenuPage } from "./pages/AdminMenuPage";
import { KitchenPage } from "./pages/KitchenPage";
import { LoginPage } from "./pages/LoginPage";
import { MenuSearchPage } from "./pages/MenuSearchPage";
import { OpenTablePage } from "./pages/OpenTablePage";
import { OrderPage } from "./pages/OrderPage";
import { OrderSummaryPage } from "./pages/OrderSummaryPage";
import { TablesPage } from "./pages/TablesPage";
import { TableDetailPage } from "./pages/TableDetailPage";

function HomeRedirect() {
  const auth = getAuth();
  return <Navigate to={auth ? getHomePath(auth.staff.role) : "/login"} replace />;
}

export default function App() {
  return (
    <>
      <OfflineBanner />
      <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/tables"
          element={<ProtectedRoute area="pos"><TablesPage /></ProtectedRoute>}
        />
        <Route
          path="/tables/:id"
          element={<ProtectedRoute area="pos"><TableDetailPage /></ProtectedRoute>}
        />
        <Route
          path="/tables/:id/open"
          element={<ProtectedRoute area="pos"><OpenTablePage /></ProtectedRoute>}
        />
        <Route
          path="/tables/:id/order"
          element={<ProtectedRoute area="pos"><OrderPage /></ProtectedRoute>}
        />
        <Route
          path="/tables/:id/search"
          element={<ProtectedRoute area="pos"><MenuSearchPage /></ProtectedRoute>}
        />
        <Route
          path="/tables/:id/summary"
          element={<ProtectedRoute area="pos"><OrderSummaryPage /></ProtectedRoute>}
        />
        <Route
          path="/kitchen"
          element={<ProtectedRoute area="kitchen"><KitchenPage /></ProtectedRoute>}
        />
        <Route
          path="/admin/menu/categories"
          element={<ProtectedRoute area="admin"><AdminMenuPage /></ProtectedRoute>}
        />
        <Route
          path="/admin/menu/new"
          element={<ProtectedRoute area="admin"><AdminMenuItemPage /></ProtectedRoute>}
        />
        <Route
          path="/admin/menu/:id/edit"
          element={<ProtectedRoute area="admin"><AdminMenuItemPage /></ProtectedRoute>}
        />
        <Route path="*" element={<HomeRedirect />} />
      </Routes>
    </>
  );
}
