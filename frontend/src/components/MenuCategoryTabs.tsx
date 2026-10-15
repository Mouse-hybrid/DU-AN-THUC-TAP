import type { components } from "../api/schema";

type MenuCategory = components["schemas"]["MenuCategoryOut"];

interface MenuCategoryTabsProps {
  categories: MenuCategory[];
  selectedId: string | null;
  disabled?: boolean;
  onChange: (categoryId: string | null) => void;
}

export function MenuCategoryTabs({ categories, selectedId, disabled = false, onChange }: MenuCategoryTabsProps) {
  return (
    <div className="nova-category-tabs" role="tablist" aria-label="Nhóm món">
      <button
        className={`nova-category-tab${selectedId === null ? " nova-category-tab--active" : ""}`}
        type="button"
        role="tab"
        aria-selected={selectedId === null}
        disabled={disabled}
        onClick={() => onChange(null)}
      >
        Tất cả
      </button>
      {categories.map((category) => (
        <button
          key={category.id}
          className={`nova-category-tab${selectedId === category.id ? " nova-category-tab--active" : ""}`}
          type="button"
          role="tab"
          aria-selected={selectedId === category.id}
          disabled={disabled}
          onClick={() => onChange(category.id)}
        >
          {category.name}
        </button>
      ))}
    </div>
  );
}
