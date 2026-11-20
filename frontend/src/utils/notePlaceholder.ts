/**
 * Gợi ý trong ô ghi chú món, hợp với loại món: đồ uống gợi ý đá, đường; món ăn gợi ý cay, hành.
 * Thực đơn chưa có trường "loại món" nên đoán theo tên nhóm (vd "Đồ uống"), rồi theo tên món.
 */
const DRINK_WORDS = ["uống", "trà", "cà phê", "cafe", "coffee", "nước", "sinh tố", "nước ép", "soda", "bia", "sữa", "đá xay", "trà sữa", "rượu", "cocktail"];

function normalize(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

export function isDrink(itemName: string, categoryName?: string | null): boolean {
  if (categoryName && normalize(categoryName).includes("uống")) return true;
  const name = normalize(itemName);
  return DRINK_WORDS.some((word) => name.includes(word));
}

export function notePlaceholder(itemName: string, categoryName?: string | null): string {
  return isDrink(itemName, categoryName) ? "Ví dụ: ít đá, ít ngọt" : "Ví dụ: ít cay, không hành";
}
