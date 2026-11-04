import { buildPageList } from "../utils/paging";
import { Icon } from "./Icon";

interface PaginationProps {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
}

export function Pagination({ page, pageCount, onChange }: PaginationProps) {
  if (pageCount <= 1) return null;
  return (
    <nav className="nova-pagination" aria-label="Phân trang">
      <button
        type="button"
        className="nova-page-button"
        aria-label="Trang trước"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        <Icon name="chevron-left" />
      </button>
      {buildPageList(page, pageCount).map((value, index) => (value === null ? (
        <span key={`gap-${index}`} className="nova-page-gap" aria-hidden="true">…</span>
      ) : (
        <button
          key={value}
          type="button"
          className={`nova-page-button${value === page ? " nova-page-button--active" : ""}`}
          aria-label={`Trang ${value}`}
          aria-current={value === page ? "page" : undefined}
          onClick={() => onChange(value)}
        >
          {value}
        </button>
      )))}
      <button
        type="button"
        className="nova-page-button"
        aria-label="Trang sau"
        disabled={page >= pageCount}
        onClick={() => onChange(page + 1)}
      >
        <Icon name="chevron-right" />
      </button>
    </nav>
  );
}
