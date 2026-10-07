import { apiRequest, createIdempotencyKey, getApiErrorMessage } from "../api.js";
import { logout, requireAuth } from "../auth.js";
import { initOfflineBanner, setAlert, setButtonPending, setFlash } from "../ui.js";

const auth = requireAuth();
const params = new URLSearchParams(window.location.search);
const tableId = params.get("table_id");
const loadingState = document.querySelector("#nova-open-loading");
const errorState = document.querySelector("#nova-open-error");
const errorMessage = document.querySelector("#nova-open-error-message");
const retryButton = document.querySelector("#nova-open-retry");
const form = document.querySelector("#nova-open-form");
const tableCode = document.querySelector("#nova-table-code");
const tableDescription = document.querySelector("#nova-table-description");
const guestInput = document.querySelector("#nova-guest-count");
const guestError = document.querySelector("#nova-guest-error");
const minusButton = document.querySelector("#nova-guest-minus");
const plusButton = document.querySelector("#nova-guest-plus");
const submitButton = document.querySelector("#nova-open-submit");
const alert = document.querySelector("#nova-open-alert");
const logoutButton = document.querySelector("#nova-logout");
const staffName = document.querySelector("#nova-staff-name");

let selectedTable = null;

initOfflineBanner();

if (auth?.staff?.role === "KITCHEN") {
  window.location.replace("kitchen.html");
} else if (auth) {
  staffName.textContent = auth.staff?.full_name || auth.staff?.username || "Nhân viên";
  logoutButton.addEventListener("click", logout);
  loadTable();
}

retryButton.addEventListener("click", loadTable);
minusButton.addEventListener("click", () => changeGuestCount(-1));
plusButton.addEventListener("click", () => changeGuestCount(1));
guestInput.addEventListener("input", validateGuestCount);

function showLoadError(message) {
  loadingState.hidden = true;
  form.hidden = true;
  errorState.hidden = false;
  errorMessage.textContent = message;
}

async function loadTable() {
  if (!tableId) {
    showLoadError("Thiếu mã bàn trong đường dẫn.");
    return;
  }

  loadingState.hidden = false;
  errorState.hidden = true;
  form.hidden = true;
  try {
    const tables = await apiRequest("/api/v1/tables");
    selectedTable = tables.find((table) => table.id === tableId);
    if (!selectedTable) {
      showLoadError("Không tìm thấy bàn được chọn.");
      return;
    }
    if (selectedTable.status !== "AVAILABLE") {
      showLoadError("Bàn này không còn ở trạng thái trống. Vui lòng quay lại và làm mới sơ đồ bàn.");
      return;
    }

    tableCode.value = selectedTable.code;
    tableDescription.textContent = `${selectedTable.seats} chỗ ngồi · Đang trống`;
    loadingState.hidden = true;
    form.hidden = false;
  } catch (error) {
    showLoadError(getApiErrorMessage(error));
  }
}

function normalizedGuestCount() {
  return Number(guestInput.value);
}

function validateGuestCount() {
  const value = normalizedGuestCount();
  const valid = Number.isInteger(value) && value >= 1 && value <= 100;
  guestInput.setAttribute("aria-invalid", String(!valid));
  guestError.hidden = valid;
  return valid;
}

function changeGuestCount(delta) {
  const current = Number.isInteger(normalizedGuestCount()) ? normalizedGuestCount() : 1;
  guestInput.value = String(Math.min(100, Math.max(1, current + delta)));
  validateGuestCount();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAlert(alert);
  if (!selectedTable || !validateGuestCount()) return;

  const idempotencyKey = createIdempotencyKey();
  setButtonPending(submitButton, true, "Đang mở bàn…");
  guestInput.disabled = true;
  minusButton.disabled = true;
  plusButton.disabled = true;

  try {
    await apiRequest(`/api/v1/tables/${encodeURIComponent(selectedTable.id)}/open-session`, {
      method: "POST",
      body: { guest_count: normalizedGuestCount() },
      idempotencyKey,
    });
    setFlash("Đã mở bàn", "success");
    window.location.replace("tables.html");
  } catch (error) {
    setAlert(alert, getApiErrorMessage(error));
  } finally {
    setButtonPending(submitButton, false);
    guestInput.disabled = false;
    minusButton.disabled = false;
    plusButton.disabled = false;
  }
});
