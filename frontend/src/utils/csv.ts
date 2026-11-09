const BOM = String.fromCharCode(0xfeff);

function escapeCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Tải file CSV (UTF-8 có BOM để Excel đọc đúng tiếng Việt) từ dữ liệu đang hiển thị, không gọi API. */
export function downloadCsv(filename: string, header: readonly string[], rows: readonly (readonly string[])[]): void {
  const lines = [header, ...rows].map((row) => row.map(escapeCell).join(","));
  const blob = new Blob([`${BOM}${lines.join("\r\n")}\r\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Lưu một Blob đã tải từ API thành file trên máy. */
export function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
