import { apiRequest, getApiErrorMessage } from "../api.js";
import { logout, requireAuth } from "../auth.js";
import { formatOpenDuration, tableStatusLabel } from "../format.js";
import { consumeFlash, initOfflineBanner, renderState, setButtonPending, showToast } from "../ui.js";

const auth = requireAuth();
const tablesView = document.querySelector("#nova-tables-view");
const kitchenPlaceholder = document.querySelector("#nova-kitchen-placeholder");
const stateContainer = document.querySelector("#nova-tables-state");
const grid = document.querySelector("#nova-tables-grid");
const template = document.querySelector("#nova-table-card-template");
const filter = document.querySelector("#nova-status-filter");
const refreshButton = document.querySelector("#nova-refresh");
const logoutButton = document.querySelector("#nova-logout");
const staffName = document.querySelector("#nova-staff-name");

let tables = [];

initOfflineBanner();

if (auth?.staff?.role === "KITCHEN") {
  window.location.replace("kitchen.html");
} else if (auth) {
  staffName.textContent = auth.staff?.full_name || auth.staff?.username || "Nhân viên";
  logoutButton.addEventListener("click", logout);

  const isKitchenMode = new URLSearchParams(window.location.search).get("mode") === "kitchen";

  if (isKitchenMode) {
    tablesView.hidden = true;
    kitchenPlaceholder.hidden = false;
  } else {
    const flash = consumeFlash();
    if (flash) showToast(flash.message, flash.type);
    loadTables();
  }
}

filter.addEventListener("change", renderTables);
refreshButton.addEventListener("click", loadTables);

async function loadTables() {
  grid.hidden = true;
  setButtonPending(refreshButton, true, "Đang tải…");
  renderState(stateContainer, {
    title: "Đang tải sơ đồ bàn",
    message: "Vui lòng chờ trong giây lát.",
    type: "loading",
  });

  try {
    tables = await apiRequest("/api/v1/tables");
    renderTables();
  } catch (error) {
    grid.hidden = true;
    renderState(stateContainer, {
      title: "Không thể tải sơ đồ bàn",
      message: getApiErrorMessage(error),
      type: "error",
      retryLabel: "Thử lại",
      onRetry: loadTables,
    });
  } finally {
    setButtonPending(refreshButton, false);
  }
}

function renderTables() {
  const selectedStatus = filter.value;
  const visibleTables = selectedStatus === "ALL"
    ? tables
    : tables.filter((table) => table.status === selectedStatus);

  grid.replaceChildren();
  if (!visibleTables.length) {
    grid.hidden = true;
    renderState(stateContainer, {
      title: tables.length ? "Không có bàn phù hợp" : "Chưa có dữ liệu bàn",
      message: tables.length ? "Hãy chọn trạng thái khác để xem bàn." : "Nhấn Thử lại để tải dữ liệu mới nhất.",
      onRetry: loadTables,
    });
    return;
  }

  stateContainer.hidden = true;
  grid.hidden = false;
  visibleTables.forEach((table) => grid.append(createTableCard(table)));
}

function createTableCard(table) {
  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector(".nova-table-card");
  const statusBadge = fragment.querySelector(".nova-status-badge");
  fragment.querySelector(".nova-table-code").textContent = table.code;
  fragment.querySelector(".nova-table-meta").textContent = `${table.seats} chỗ ngồi`;

  statusBadge.textContent = tableStatusLabel(table.status);
  statusBadge.classList.add(`nova-status--${table.status.toLowerCase()}`);

  const sessionText = table.guest_count
    ? `${table.guest_count} khách · ${formatOpenDuration(table.opened_at)}`
    : table.status === "AVAILABLE"
      ? "Sẵn sàng mở bàn"
      : "Chưa có phiên đang mở";
  fragment.querySelector(".nova-table-session").textContent = sessionText;

  card.setAttribute("aria-label", `${table.code}, ${tableStatusLabel(table.status)}, ${table.seats} chỗ ngồi`);
  card.addEventListener("click", () => {
    if (table.status === "AVAILABLE") {
      window.location.href = `open-table.html?table_id=${encodeURIComponent(table.id)}`;
      return;
    }
    showToast("Chi tiết bàn sắp có", "info");
  });
  return fragment;
}
