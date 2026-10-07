import { FLASH_STORAGE_KEY } from "./config.js";

export function initOfflineBanner() {
  const banner = document.querySelector("#nova-offline-banner");
  if (!banner) return;

  const update = () => {
    banner.hidden = navigator.onLine;
  };

  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

export function setButtonPending(button, pending, pendingLabel = "Đang gửi…") {
  if (!button) return;
  const label = button.querySelector(".nova-button-label");
  const spinner = button.querySelector(".nova-spinner");

  if (!button.dataset.defaultLabel && label) {
    button.dataset.defaultLabel = label.textContent;
  }

  button.disabled = pending;
  button.setAttribute("aria-busy", String(pending));
  if (label) label.textContent = pending ? pendingLabel : button.dataset.defaultLabel;
  if (spinner) spinner.hidden = !pending;
}

export function setAlert(element, message = "") {
  if (!element) return;
  element.textContent = message;
  element.hidden = !message;
}

export function showToast(message, type = "info", duration = 4200) {
  const region = document.querySelector("#nova-toast-region");
  if (!region || !message) return;

  const toast = document.createElement("div");
  toast.className = `nova-toast nova-toast--${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.textContent = message;
  region.append(toast);
  window.setTimeout(() => toast.remove(), duration);
}

export function setFlash(message, type = "success") {
  sessionStorage.setItem(FLASH_STORAGE_KEY, JSON.stringify({ message, type }));
}

export function consumeFlash() {
  const raw = sessionStorage.getItem(FLASH_STORAGE_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(FLASH_STORAGE_KEY);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function renderState(container, { title, message, type = "default", retryLabel, onRetry }) {
  container.hidden = false;
  container.className = `nova-state-card${type === "error" ? " nova-state-card--error" : ""}`;
  container.replaceChildren();

  if (type === "loading") {
    const spinner = document.createElement("span");
    spinner.className = "nova-spinner nova-spinner--large";
    spinner.setAttribute("aria-hidden", "true");
    container.append(spinner);
  }

  const heading = document.createElement("h2");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  container.append(heading, paragraph);

  if (onRetry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nova-button nova-button--secondary";
    button.textContent = retryLabel || "Thử lại";
    button.addEventListener("click", onRetry);
    container.append(button);
  }
}
