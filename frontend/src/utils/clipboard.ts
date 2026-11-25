/**
 * Chép chữ vào clipboard. `navigator.clipboard` chỉ có trên HTTPS hoặc localhost; staging đang
 * chạy HTTP nên dùng cách cũ (textarea ẩn + `execCommand("copy")`) làm dự phòng.
 * Trả về true nếu chép được.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Bị từ chối quyền: thử cách dự phòng bên dưới.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  area.select();
  area.setSelectionRange(0, text.length);
  let ok: boolean;
  try {
    // execCommand đã cũ nhưng vẫn là cách duy nhất chạy được trên trang HTTP.
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  if (previous && selection) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return ok;
}
