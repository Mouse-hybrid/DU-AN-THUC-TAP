/**
 * Tạo Idempotency-Key (UUID v4) cho mọi request POST/PATCH/DELETE.
 *
 * Không gọi thẳng `crypto.randomUUID()`: trình duyệt chỉ cấp hàm này trên trang
 * "an toàn" (HTTPS hoặc localhost). Staging đang chạy HTTP qua IP nên hàm không
 * tồn tại và gọi vào sẽ ném TypeError. `crypto.getRandomValues()` thì có trên
 * cả HTTP, nên dùng nó làm đường dự phòng.
 */
export function createIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte, index) => {
    if (index === 6) byte = (byte & 0x0f) | 0x40; // version 4
    if (index === 8) byte = (byte & 0x3f) | 0x80; // variant RFC 4122
    return byte.toString(16).padStart(2, "0");
  }).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
