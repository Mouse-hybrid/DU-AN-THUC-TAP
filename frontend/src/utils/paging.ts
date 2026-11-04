/**
 * Backend chỉ trả từng trang (limit/offset) và không có tổng số. Màn tra cứu cần tổng,
 * đếm theo trạng thái và phân trang, nên gom các trang liên tiếp tới khi hết dữ liệu
 * hoặc chạm giới hạn an toàn `maxPages`.
 */
export async function fetchAllPages<T>(
  fetchPage: (offset: number, limit: number) => Promise<T[]>,
  pageSize: number,
  maxPages: number,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const chunk = await fetchPage(page * pageSize, pageSize);
    rows.push(...chunk);
    if (chunk.length < pageSize) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** Danh sách số trang có dấu "…" (null) khi nhiều trang, ví dụ 1 2 3 … 9. */
export function buildPageList(page: number, pageCount: number): Array<number | null> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const pages = new Set<number>([1, 2, pageCount - 1, pageCount, page - 1, page, page + 1]);
  const sorted = [...pages].filter((value) => value >= 1 && value <= pageCount).sort((a, b) => a - b);
  const result: Array<number | null> = [];
  sorted.forEach((value, index) => {
    const previous = sorted[index - 1];
    if (previous !== undefined && value - previous > 1) result.push(null);
    result.push(value);
  });
  return result;
}
