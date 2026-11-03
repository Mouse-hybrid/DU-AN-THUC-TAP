interface MenuThumbProps {
  name: string;
  className?: string;
}

// Ảnh món lấy từ Figma (public/menu-images). API món chưa có trường ảnh nên ghép theo tên món;
// món không có ảnh trong danh sách này hiện ô chữ cái đầu. Khi backend có image_url thì thay ở đây.
const KNOWN_IMAGES = new Set([
  "pho-bo",
  "bun-cha",
  "goi-cuon",
  "cha-gio",
  "com-tam-suon",
  "ca-phe-sua-da",
  "tra-da",
  "nuoc-cam",
]);

function menuImageSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function MenuThumb({ name, className = "" }: MenuThumbProps) {
  const slug = menuImageSlug(name);
  const classes = `nova-thumb${className ? ` ${className}` : ""}`;
  if (KNOWN_IMAGES.has(slug)) {
    return <img className={`${classes} nova-thumb--photo`} src={`/menu-images/${slug}.jpg`} alt="" loading="lazy" decoding="async" />;
  }
  return <span className={classes} aria-hidden="true">{name.trim().charAt(0).toUpperCase() || "?"}</span>;
}
