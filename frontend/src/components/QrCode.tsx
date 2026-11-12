import { useMemo } from "react";
import qrcode from "qrcode-generator";

interface QrCodeProps {
  value: string;
  size?: number;
  label: string;
}

/** Vẽ mã QR thành SVG ngay trên thiết bị (không gọi dịch vụ ngoài). */
export function QrCode({ value, size = 220, label }: QrCodeProps) {
  const path = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
      }
    }
    return { d, count };
  }, [value]);
  const view = path.count + 8;
  return (
    <svg className="nova-qr-code" role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${view} ${view}`} shapeRendering="crispEdges">
      <rect width={view} height={view} fill="#fff" />
      <path d={path.d} fill="#0f2a26" />
    </svg>
  );
}
