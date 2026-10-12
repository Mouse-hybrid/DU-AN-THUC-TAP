import { useEffect } from "react";
import { AppShell } from "../components/AppShell";

export function KitchenPage() {
  useEffect(() => {
    document.title = "Màn bếp · NOVA POS";
  }, []);

  return (
    <AppShell
      topbar={
        <div>
          <p className="nova-topbar-label">NOVA Kitchen</p>
          <strong>Màn bếp</strong>
        </div>
      }
    >
      <main className="nova-content nova-content--centered">
        <section className="nova-placeholder-card">
          <span className="nova-placeholder-icon" aria-hidden="true">K</span>
          <h1>Màn bếp sắp có</h1>
        </section>
      </main>
    </AppShell>
  );
}
