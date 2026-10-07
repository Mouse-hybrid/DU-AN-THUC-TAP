import { logout, requireAuth } from "../auth.js";
import { initOfflineBanner } from "../ui.js";

const auth = requireAuth();
const logoutButton = document.querySelector("#nova-logout");
const staffName = document.querySelector("#nova-staff-name");

initOfflineBanner();

if (auth?.staff?.role !== "KITCHEN") {
  window.location.replace("tables.html");
} else {
  staffName.textContent = auth.staff?.full_name || auth.staff?.username || "Nhân viên bếp";
  logoutButton.addEventListener("click", logout);
}
