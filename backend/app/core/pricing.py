"""Phí phục vụ và VAT trên từng đơn (specs/003-vat-hoa-don, research R-1..R-3).

Thứ tự: tạm tính → trừ giảm giá (`base`) → phí phục vụ trên `base` → VAT trên `base + phí`.
Giá thực đơn đã gồm VAT thì không cộng VAT vào số phải trả, chỉ tách phần VAT nằm trong giá để
in hóa đơn. Mỗi dòng làm tròn tới 1đ, nửa lên, trên từng đơn (mỗi bill tách là một đơn).

Tỉ lệ được chốt lên đơn khi đơn chuyển BILLING (`lock_pricing_rates`): từ lúc đó mới thu tiền
được và không đổi món được nữa, nên Supervisor đổi cấu hình không làm lệch đơn đang thu dở.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from app.db.models import Order, Outlet

_ZERO = Decimal("0")
_HUNDRED = Decimal("100")

# Đơn đã qua bước yêu cầu thanh toán: đọc tỉ lệ đã chốt trên đơn, không đọc cấu hình outlet.
LOCKED_ORDER_STATUSES = ("BILLING", "PAID", "CLOSED")


@dataclass(frozen=True)
class PricingRates:
    vat_rate: Decimal = _ZERO
    prices_include_vat: bool = False
    service_charge_rate: Decimal = _ZERO
    locked: bool = False


@dataclass(frozen=True)
class Charges:
    service_charge: Decimal
    tax_total: Decimal
    total: Decimal


def _round_vnd(value: Decimal) -> Decimal:
    return value.quantize(Decimal("1"), rounding=ROUND_HALF_UP)


def compute_charges(base: Decimal, rates: PricingRates) -> Charges:
    """`base` = tạm tính đã trừ giảm giá. Trả phí phục vụ, VAT và số phải trả."""
    base = Decimal(base)
    if base <= 0:
        return Charges(_ZERO, _ZERO, max(base, _ZERO))
    service_charge = _round_vnd(base * Decimal(rates.service_charge_rate) / _HUNDRED)
    taxable = base + service_charge
    vat_rate = Decimal(rates.vat_rate)
    if rates.prices_include_vat:
        tax_total = _round_vnd(taxable * vat_rate / (_HUNDRED + vat_rate))
        return Charges(service_charge, tax_total, taxable)
    tax_total = _round_vnd(taxable * vat_rate / _HUNDRED)
    return Charges(service_charge, tax_total, taxable + tax_total)


def outlet_rates(outlet: Outlet) -> PricingRates:
    return PricingRates(
        vat_rate=Decimal(outlet.vat_rate or 0),
        prices_include_vat=bool(outlet.prices_include_vat),
        service_charge_rate=Decimal(outlet.service_charge_rate or 0),
    )


def rates_for_order(order: Order) -> PricingRates:
    """Đơn đã BILLING trở đi dùng tỉ lệ đã chốt. Cột null (đơn trước migration 0016) coi là 0,
    để bật VAT không làm đổi số của đơn cũ. Đơn chưa BILLING dùng cấu hình outlet hiện tại."""
    if order.status in LOCKED_ORDER_STATUSES:
        return PricingRates(
            vat_rate=Decimal(order.vat_rate_applied or 0),
            prices_include_vat=bool(order.prices_include_vat_applied),
            service_charge_rate=Decimal(order.service_charge_rate_applied or 0),
            locked=True,
        )
    return outlet_rates(order.table_session.table.outlet)


def lock_pricing_rates(order: Order, outlet: Outlet) -> PricingRates:
    """Gọi đúng lúc đơn chuyển BILLING. Trả tỉ lệ đã chốt để ghi vào audit."""
    rates = outlet_rates(outlet)
    order.vat_rate_applied = rates.vat_rate
    order.prices_include_vat_applied = rates.prices_include_vat
    order.service_charge_rate_applied = rates.service_charge_rate
    return PricingRates(
        rates.vat_rate, rates.prices_include_vat, rates.service_charge_rate, locked=True
    )


def rates_audit_payload(rates: PricingRates) -> dict:
    return {
        "vat_rate": str(rates.vat_rate),
        "prices_include_vat": rates.prices_include_vat,
        "service_charge_rate": str(rates.service_charge_rate),
    }
